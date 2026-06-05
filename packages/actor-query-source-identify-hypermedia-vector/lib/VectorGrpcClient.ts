import type { Bindings, ComunicaDataFactory } from '@comunica/types';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type * as RDF from '@rdfjs/types';

export const KEY_VECTOR_TRANSPORT = '@comunica/actor-query-source-identify-hypermedia-vector:transport';

export type VectorTransport = 'http' | 'grpc';

interface ITermJson {
  type: string;
  value: string;
  lang?: string;
  datatype?: string;
}

// eslint-disable-next-line node/no-path-concat
const PROTO_PATH = `${__dirname}/../proto/vector/v1/pattern.proto`;

let cachedPackage: grpc.GrpcObject | undefined;

function loadProto(): grpc.GrpcObject {
  if (!cachedPackage) {
    // eslint-disable-next-line no-sync
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    cachedPackage = grpc.loadPackageDefinition(packageDefinition);
  }
  return cachedPackage;
}

export function resolveTransport(contextJS: Record<string, unknown>, url: string): VectorTransport {
  const fromCtx = contextJS[KEY_VECTOR_TRANSPORT];
  if (fromCtx === 'http' || fromCtx === 'grpc') {
    return fromCtx;
  }
  if (url.startsWith('grpc://')) {
    return 'grpc';
  }
  return 'http';
}

export function resolveVectorEndpoint(transport: VectorTransport, source: string): string {
  const trimmed = source.trim();
  if (transport === 'http') {
    if (trimmed.startsWith('grpc://')) {
      throw new Error('Cannot use --http with a grpc:// source URL');
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      if (trimmed.includes('/vector')) {
        return trimmed;
      }
      return `${trimmed.replace(/\/$/u, '')}/vector`;
    }
    if (!trimmed.includes('/')) {
      return `http://${trimmed}/vector`;
    }
    return `http://${trimmed}`;
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    throw new Error('Cannot use --grpc with an http:// source URL');
  }
  if (trimmed.startsWith('grpc://')) {
    return trimmed;
  }
  return `grpc://${trimmed}`;
}

export function parseGrpcTarget(endpoint: string): string {
  const url = endpoint.startsWith('grpc://') ? endpoint.slice('grpc://'.length) : endpoint;
  return url.includes(':') ? url : `${url}:50051`;
}

export function variableNamesFromVars(vars: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(vars)) {
    return names;
  }
  for (const v of vars) {
    if (typeof v === 'string') {
      names.add(v.startsWith('?') ? v.slice(1) : v);
    }
  }
  return names;
}

/** Encode Comunica term JSON for protobuf (variables must not become type iri). */
export function termToProto(term: unknown, variableNames: Set<string>): Record<string, string> {
  if (term === null || term === undefined) {
    return {};
  }
  if (typeof term === 'string') {
    const stripped = term.startsWith('?') ? term.slice(1) : term;
    if (term.startsWith('?') || variableNames.has(stripped)) {
      return { type: 'variable', value: stripped };
    }
    return { type: 'iri', value: term };
  }
  const t = <ITermJson & { termType?: string }> term;
  if (t.termType === 'Variable' || t.type === 'variable') {
    const stripped = (t.value ?? '').replace(/^\?/u, '');
    return { type: 'variable', value: stripped };
  }
  const out: Record<string, string> = { type: t.type, value: t.value };
  if (t.lang) {
    out.lang = t.lang;
  }
  if (t.datatype) {
    out.datatype = t.datatype;
  }
  return out;
}

export function jsonBodyToGrpcRequest(body: Record<string, unknown>): Record<string, unknown> {
  const pattern = <Record<string, unknown>> body.pattern;
  const varNames = variableNamesFromVars(body.vars);
  const req: Record<string, unknown> = {
    pattern: {
      subject: termToProto(pattern?.subject, varNames),
      predicate: termToProto(pattern?.predicate, varNames),
      object: termToProto(pattern?.object, varNames),
    },
    vars: body.vars ?? [],
    values: [],
  };
  const values = <Record<string, unknown>[] | undefined> body.values;
  if (values) {
    const valueRows: Record<string, unknown>[] = [];
    for (const row of values) {
      const bindings: Record<string, unknown> = {};
      for (const [ k, v ] of Object.entries(row)) {
        bindings[k] = termToProto(v, varNames);
      }
      valueRows.push({ bindings });
    }
    req.values = valueRows;
  }
  if (body.k !== undefined && body.k !== null) {
    req.k = Number(body.k);
  }
  if (body.adaptive_multipliers) {
    req.adaptiveMultipliers = body.adaptive_multipliers;
  }
  if (body.adaptive_jaccard !== undefined && body.adaptive_jaccard !== null) {
    req.adaptiveJaccard = Number(body.adaptive_jaccard);
  }
  return req;
}

export interface IVectorGrpcClient {
  queryPattern: (
    request: Record<string, unknown>,
    onRow: (row: Record<string, unknown>) => void,
  ) => Promise<void>;
}

type GrpcPatternClient = {
  queryPattern: (
    request: Record<string, unknown>,
  ) => grpc.ClientReadableStream<Record<string, unknown>>;
};

export class VectorGrpcClient implements IVectorGrpcClient {
  private readonly client: GrpcPatternClient;

  public constructor(endpoint: string) {
    const target = parseGrpcTarget(endpoint);
    type ProtoRoot = {
      vector: {
        v1: {
          VectorPatternService: new(
            address: string,
            credentials: grpc.ChannelCredentials,
          ) => GrpcPatternClient;
        };
      };
    };
    const proto = <ProtoRoot> <unknown> loadProto();
    const Service = proto.vector.v1.VectorPatternService;
    this.client = new Service(target, grpc.credentials.createInsecure());
  }

  public queryPattern(
    request: Record<string, unknown>,
    onRow: (row: Record<string, unknown>) => void,
  ): Promise<void> {
    const grpcReq = jsonBodyToGrpcRequest(request);
    const call = this.client.queryPattern(grpcReq);
    return new Promise((resolve, reject) => {
      call.on('data', (event: Record<string, unknown>) => {
        const error = <{ message?: string } | undefined> event.error;
        if (error?.message) {
          reject(new Error(error.message));
          return;
        }
        const row = <{ bindings?: Record<string, ITermJson> } | undefined> event.row;
        if (row?.bindings) {
          onRow(bindingsMapToRow(row.bindings));
        }
        const rowBatch = <{ rows?: { bindings?: Record<string, ITermJson> }[] } | undefined> event.rowBatch;
        if (rowBatch?.rows) {
          for (const batchRow of rowBatch.rows) {
            if (batchRow.bindings) {
              onRow(bindingsMapToRow(batchRow.bindings));
            }
          }
        }
      });
      call.on('error', (err: Error) => reject(err));
      call.on('end', () => resolve());
    });
  }
}

function bindingsMapToRow(bindings: Record<string, ITermJson>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [ key, term ] of Object.entries(bindings)) {
    if (!term?.value && !term?.type) {
      continue;
    }
    row[key] = { type: term.type, value: term.value, lang: term.lang, datatype: term.datatype };
  }
  return row;
}

function termFromJson(term: unknown, df: ComunicaDataFactory): RDF.Term {
  const t = <ITermJson> term;
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

export async function queryBindingsViaGrpc(
  endpoint: string,
  body: Record<string, unknown>,
  df: ComunicaDataFactory,
  bindingsFactory: { bindings: (entries: [RDF.Variable, RDF.Term][]) => Bindings },
  clientFactory: (ep: string) => IVectorGrpcClient = ep => new VectorGrpcClient(ep),
): Promise<Bindings[]> {
  const client = clientFactory(endpoint);
  const bindings: Bindings[] = [];
  await client.queryPattern(body, (row) => {
    const entries = Object.entries(row)
      .map(([ v, t ]) => <[RDF.Variable, RDF.Term]> [ df.variable(v), termFromJson(t, df) ]);
    bindings.push(bindingsFactory.bindings(entries));
  });
  return bindings;
}
