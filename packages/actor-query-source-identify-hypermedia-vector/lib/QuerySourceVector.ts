/* eslint-disable max-len, style/multiline-ternary, unicorn/no-useless-undefined, style/arrow-parens, ts/consistent-type-assertions, unicorn/no-useless-promise-resolve-reject, unicorn/no-negated-condition, style/quote-props, ts/no-unnecessary-type-assertion */
import type { MediatorHttp } from '@comunica/bus-http';
import { ActorHttp } from '@comunica/bus-http';
import type {
  Bindings,
  BindingsStream,
  ComunicaDataFactory,
  FragmentSelectorShape,
  IActionContext,
  IQueryBindingsOptions,
  IQuerySource,
  MetadataBindings,
  QueryResultCardinality,
} from '@comunica/types';
import type { AlgebraFactory } from '@comunica/utils-algebra';
import { Algebra, algebraUtils } from '@comunica/utils-algebra';
import type { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type * as RDF from '@rdfjs/types';
import { TransformIterator, ArrayIterator } from 'asynciterator';
import type { IVectorGrpcClient } from './VectorGrpcClient';
import {
  queryBindingsStreamViaGrpc,
  resolveTransport,
  VectorGrpcClient,
} from './VectorGrpcClient';

export class QuerySourceVector implements IQuerySource {
  public static createGrpcClient: (endpoint: string) => IVectorGrpcClient =
    (endpoint: string) => new VectorGrpcClient(endpoint);

  public readonly referenceValue: string;
  private readonly url: string;
  private readonly context: IActionContext;
  private readonly mediatorHttp: MediatorHttp;
  private readonly dataFactory: ComunicaDataFactory;
  private readonly algebraFactory: AlgebraFactory;
  private readonly bindingsFactory: BindingsFactory;

  public constructor(
    url: string,
    context: IActionContext,
    mediatorHttp: MediatorHttp,
    dataFactory: ComunicaDataFactory,
    algebraFactory: AlgebraFactory,
    bindingsFactory: BindingsFactory,
  ) {
    this.referenceValue = url;
    this.url = url;
    this.context = context;
    this.mediatorHttp = mediatorHttp;
    this.dataFactory = dataFactory;
    this.algebraFactory = algebraFactory;
    this.bindingsFactory = bindingsFactory;
  }

  public async getFilterFactor(_context: IActionContext): Promise<number> {
    return 1;
  }

  public async getSelectorShape(): Promise<FragmentSelectorShape> {
    return {
      type: 'operation',
      operation: {
        operationType: 'pattern',
        pattern: this.algebraFactory.createPattern(
          this.dataFactory.variable('s'),
          this.dataFactory.variable('p'),
          this.dataFactory.variable('o'),
        ),
      },
      joinBindings: true,
    };
  }

  public queryBindings(
    operationIn: Algebra.Operation,
    context: IActionContext,
    options?: IQueryBindingsOptions,
  ): BindingsStream {
    const contextToUse = context || this.context;
    const contextJS = contextToUse.toJS();

    const materializationPromise = (async() => {
      if (options?.joinBindings) {
        const materialized: RDF.Bindings[] = [];
        try {
          for await (const binding of options.joinBindings.bindings) {
            materialized.push(binding);
          }
          return {
            bindings: materialized,
            metadata: options.joinBindings.metadata,
          };
        } catch {
          return undefined;
        }
      }
      return undefined;
    })();

    const operationPromise = materializationPromise.then(materialized => {
      if (materialized) {
        const materializedJoinBindingsForOperation = {
          bindings: new ArrayIterator<RDF.Bindings>(materialized.bindings, { autoStart: false }) as BindingsStream,
          metadata: materialized.metadata,
        };
        return QuerySourceVector.addBindingsToOperation(this.algebraFactory, operationIn, materializedJoinBindingsForOperation);
      }
      return Promise.resolve(operationIn);
    });

    const stream: BindingsStream = new TransformIterator(async() => {
      const operation = await operationPromise;
      const pattern = QuerySourceVector.extractSinglePattern(operation);
      if (!pattern) {
        throw new Error('Vector source only supports single triple pattern operations');
      }

      const variables = algebraUtils.inScopeVariables(operation);

      const materialized = await materializationPromise;
      let joinBindingsToUse = materialized ? {
        bindings: new ArrayIterator<RDF.Bindings>(materialized.bindings, { autoStart: false }) as BindingsStream,
        metadata: materialized.metadata,
      } : undefined;
      if (!joinBindingsToUse) {
        const valuesOp = QuerySourceVector.extractValuesFromOperation(operation);
        if (valuesOp) {
          const valuesBindings: Bindings[] = valuesOp.bindings.map(b => {
            const entries: [RDF.Variable, RDF.Term][] = [];
            for (const v of valuesOp.variables) {
              const value = b[`?${v.value}`] ?? b[v.value];
              if (value && typeof value === 'object' && 'termType' in value) {
                const term = value as RDF.Term;
                if (term.termType === 'NamedNode' || term.termType === 'Literal' || term.termType === 'BlankNode') {
                  entries.push([ v, term ]);
                }
              }
            }
            return this.bindingsFactory.bindings(entries);
          });
          const valuesStream = new ArrayIterator<Bindings>(valuesBindings, { autoStart: false }) as BindingsStream;
          const state = new MetadataValidationState();
          const valuesMetadata: MetadataBindings = {
            state,
            variables: valuesOp.variables.map(v => ({ variable: v, canBeUndef: false })),
            cardinality: { type: 'exact', value: valuesOp.bindings.length },
          };
          joinBindingsToUse = { bindings: valuesStream, metadata: valuesMetadata };
        }
      }

      const kRaw = contextJS['@comunica/actor-query-source-identify-hypermedia-vector:k'];
      const k = kRaw !== undefined ? Number(kRaw) : undefined;
      const adaptiveMultipliers =
        contextJS['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveMultipliers'];
      const adaptiveJaccard =
        contextJS['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveJaccard'];

      const body = await QuerySourceVector.buildRequestBody(
        pattern,
        variables,
        joinBindingsToUse,
        this.dataFactory,
        k,
        adaptiveMultipliers,
        adaptiveJaccard,
      );

      const transport = resolveTransport(contextJS, this.url);
      if (transport === 'grpc') {
        // Return the live streaming iterator so bindings flow as the server produces them
        // (the TransformIterator pipes with backpressure); only the request body is awaited.
        return queryBindingsStreamViaGrpc(
          this.url,
          body,
          this.dataFactory,
          this.bindingsFactory,
          QuerySourceVector.createGrpcClient,
        );
      }

      const init = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
        },
        body: JSON.stringify(body),
      } as RequestInit;

      const response = await this.mediatorHttp.mediate({ input: this.url, init, context: contextToUse });

      if (!response.body) {
        throw new Error('Vector endpoint returned empty body');
      }
      const bodyText = await QuerySourceVector.readStreamToString(ActorHttp.toNodeReadable(response.body));

      const json = JSON.parse(bodyText);
      const rows: Record<string, unknown>[] = json.rows || [];
      const bindings = rows.map(row => this.rowToBindings(row));
      return new ArrayIterator(bindings, { autoStart: false });
    }, { autoStart: false });

    const state = new MetadataValidationState();
    const variables = algebraUtils.inScopeVariables(operationIn);
    stream.setProperty('metadata', {
      state,
      cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY },
      variables: variables.map(v => ({ variable: v, canBeUndef: false })),
    });

    return stream;
  }

  public queryQuads(): never {
    throw new Error('Vector source does not support quads');
  }

  public queryBoolean(): never {
    throw new Error('Vector source does not support ASK');
  }

  public queryVoid(): never {
    throw new Error('Vector source does not support UPDATE');
  }

  public static readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
  }

  protected rowToBindings(row: Record<string, unknown>): Bindings {
    const entries: [RDF.Variable, RDF.Term | undefined][] = Object.entries(row)
      .map(([ v, t ]) => [ this.dataFactory.variable(v), t ? QuerySourceVector.termFromJson(t, this.dataFactory) : undefined ]);
    const nonUndef = entries.filter((entry): entry is [RDF.Variable, RDF.Term] => entry[1] !== undefined);
    return this.bindingsFactory.bindings(nonUndef);
  }

  public static termFromJson(term: unknown, df: ComunicaDataFactory): RDF.Term {
    const t = term as { type: string; value: string; lang?: string; datatype?: string };
    if (t.type === 'iri' || t.type === 'uri') {
      return df.namedNode(t.value);
    }
    if (t.type === 'bnode') {
      return df.blankNode(t.value);
    }
    if (t.type === 'literal') {
      if (t.lang) {
        return df.literal(t.value, t.lang);
      }
      if (t.datatype) {
        return df.literal(t.value, df.namedNode(t.datatype));
      }
      return df.literal(t.value);
    }
    throw new Error(`Unsupported term JSON: ${JSON.stringify(term)}`);
  }

  public static async buildRequestBody(
    pattern: Algebra.Pattern,
    variables: RDF.Variable[],
    joinBindings: { bindings: BindingsStream; metadata: MetadataBindings } | undefined,
    df: ComunicaDataFactory,
    k?: number,
    adaptiveMultipliers?: unknown,
    adaptiveJaccard?: unknown,
  ): Promise<Record<string, unknown>> {
    const kValue = k !== undefined && k !== null ? Number(k) : undefined;
    const body: Record<string, unknown> = {
      pattern: {
        subject: QuerySourceVector.termOrVarToJson(pattern.subject),
        predicate: QuerySourceVector.termOrVarToJson(pattern.predicate),
        object: QuerySourceVector.termOrVarToJson(pattern.object),
      },
      vars: variables.map(v => v.value),
    };
    if (kValue !== undefined) {
      body.k = kValue;
    }
    if (adaptiveMultipliers !== undefined && adaptiveMultipliers !== null) {
      if (typeof adaptiveMultipliers === 'string') {
        body.adaptive_multipliers = adaptiveMultipliers.split(',')
          .map(s => Number.parseInt(s.trim(), 10))
          .filter(n => !Number.isNaN(n) && n > 0);
      } else if (Array.isArray(adaptiveMultipliers)) {
        body.adaptive_multipliers = adaptiveMultipliers;
      }
    }
    if (adaptiveJaccard !== undefined && adaptiveJaccard !== null) {
      body.adaptive_jaccard = Number(adaptiveJaccard);
    }
    if (joinBindings) {
      const rows: RDF.Bindings[] = [];
      try {
        for await (const binding of joinBindings.bindings) {
          rows.push(binding);
        }
      } catch {
        // Ignore unreadable join binding streams.
      }

      if (rows.length > 0) {
        const varNames = joinBindings.metadata.variables.map(v => v.variable.value);
        body.values = rows.map(b => Object.fromEntries(varNames
          .map(n => {
            const term = b.get(df.variable(n));
            return [ n, term ? QuerySourceVector.termOrVarToJson(term) : null ];
          })));
      }
    }
    return body;
  }

  public static termOrVarToJson(term: RDF.Term): unknown {
    if (term.termType === 'Variable') {
      return term.value;
    }
    if (term.termType === 'NamedNode') {
      return { type: 'iri', value: term.value };
    }
    if (term.termType === 'BlankNode') {
      return { type: 'bnode', value: term.value };
    }
    if (term.termType === 'Literal') {
      const lit: Record<string, string> = { type: 'literal', value: term.value };
      const dt = term.datatype?.value;
      const lang = (term as RDF.Literal).language;
      if (lang) {
        lit.lang = lang;
      } else if (dt && dt !== 'http://www.w3.org/2001/XMLSchema#string') {
        lit.datatype = dt;
      }
      return lit;
    }
    throw new Error(`Unsupported RDF term: ${term.termType}`);
  }

  public static extractSinglePattern(operation: Algebra.Operation): Algebra.Pattern | undefined {
    let found: Algebra.Pattern | undefined;
    algebraUtils.visitOperation(operation, {
      [Algebra.Types.PATTERN]: {
        preVisitor: (op) => {
          found = op;
          return { continue: false };
        },
      },
    });
    return found;
  }

  public static extractValuesFromOperation(
    operation: Algebra.Operation,
  ): Algebra.Values | undefined {
    if (operation.type === Algebra.Types.JOIN) {
      const joinOp = operation as Algebra.Join;
      if (joinOp.input.length >= 2) {
        const firstInput = joinOp.input[0];
        if (firstInput.type === Algebra.Types.VALUES) {
          return firstInput as Algebra.Values;
        }
      }
    }
    let found: Algebra.Values | undefined;
    algebraUtils.visitOperation(operation, {
      [Algebra.Types.VALUES]: {
        preVisitor: (op) => {
          found = op;
          return { continue: false };
        },
      },
    });
    return found;
  }

  public static async addBindingsToOperation(
    algebraFactory: AlgebraFactory,
    operation: Algebra.Operation,
    addBindings: { bindings: BindingsStream; metadata: MetadataBindings },
  ): Promise<Algebra.Operation> {
    const rows = await addBindings.bindings.toArray();
    if (rows.length === 0) {
      return operation;
    }
    const variables = addBindings.metadata.variables.map(v => v.variable);
    return algebraFactory.createJoin([
      algebraFactory.createValues(
        variables,
        rows.map(binding => Object.fromEntries([ ...binding ]
          .map(([ key, value ]) => [ key.value, value as RDF.Literal | RDF.NamedNode ]))),
      ),
      operation,
    ], false);
  }

  public async estimateOperationCardinality(_operation: Algebra.Operation): Promise<QueryResultCardinality> {
    return { type: 'estimate', value: Number.POSITIVE_INFINITY };
  }
}
