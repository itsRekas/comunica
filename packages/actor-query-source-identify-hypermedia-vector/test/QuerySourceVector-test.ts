import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext } from '@comunica/core';
import type { IActionContext } from '@comunica/types';
import { AlgebraFactory, Algebra } from '@comunica/utils-algebra';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { MetadataValidationState } from '@comunica/utils-metadata';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { Readable } from 'readable-stream';
import { QuerySourceVector } from '../lib/QuerySourceVector';
import '@comunica/utils-jest';

const DF = new DataFactory();
const AF = new AlgebraFactory(DF);
const BF = new BindingsFactory(DF);

describe('QuerySourceVector', () => {
  const url = 'http://example.org/vector';
  let mediatorHttp: any;
  let mediateSpy: jest.SpyInstance;
  let source: QuerySourceVector;
  let ctx: ActionContext;

  beforeEach(() => {
    const responseJson = JSON.stringify({ rows: [{ p: { type: 'iri', value: 'http://ex/p1' }}]});
    mediatorHttp = { mediate: jest.fn() };
    mediateSpy = jest.spyOn(mediatorHttp, 'mediate').mockResolvedValue({
      body: Readable.from([ Buffer.from(responseJson) ]),
    });
    ctx = new ActionContext({
      [KeysInitQuery.dataFactory.name]: DF,
      '@comunica/actor-query-source-identify-hypermedia-vector:k': 7,
    });
    source = new QuerySourceVector(url, ctx, mediatorHttp, DF, AF, BF);
  });

  it('should support getFilterFactor and getSelectorShape', async() => {
    await expect(source.getFilterFactor(ctx)).resolves.toBe(1);
    await expect(source.getSelectorShape()).resolves.toMatchObject({ type: 'operation' });
  });

  it('should query bindings via POST JSON', async() => {
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(source.queryBindings(pattern, ctx)).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
    expect(mediatorHttp.mediate).toHaveBeenCalledWith(expect.objectContaining({
      input: url,
      init: expect.objectContaining({ method: 'POST' }),
    }));
    const body = JSON.parse(mediatorHttp.mediate.mock.calls[0][0].init.body);
    expect(body.k).toBe(7);
    expect(body.vars).toEqual([ 'p' ]);
  });

  it('should fall back to the instance context when query context is omitted', async() => {
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(source.queryBindings(pattern, <IActionContext> <unknown> undefined)).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
    const body = JSON.parse(mediatorHttp.mediate.mock.calls.at(-1)[0].init.body);
    expect(body.k).toBe(7);
  });

  it('should omit k from the request body when not set in context', async() => {
    const ctxNoK = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
    const src = new QuerySourceVector(url, ctxNoK, mediatorHttp, DF, AF, BF);
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(src.queryBindings(pattern, ctxNoK)).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
    const body = JSON.parse(mediatorHttp.mediate.mock.calls.at(-1)[0].init.body);
    expect(body.k).toBeUndefined();
  });

  it('should handle responses without a rows field', async() => {
    mediateSpy.mockResolvedValueOnce({
      body: Readable.from([ Buffer.from('{}') ]),
    });
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(source.queryBindings(pattern, ctx).toArray()).resolves.toEqual([]);
  });

  it('should skip undefined terms when converting result rows', async() => {
    mediateSpy.mockResolvedValueOnce({
      body: Readable.from([ Buffer.from(JSON.stringify({
        rows: [{ p: { type: 'iri', value: 'http://ex/p1' }, q: null }],
      })) ]),
    });
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(source.queryBindings(pattern, ctx)).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
  });

  it('should reject unsupported operations', () => {
    expect(() => source.queryQuads()).toThrow('quads');
    expect(() => source.queryBoolean()).toThrow('ASK');
    expect(() => source.queryVoid()).toThrow('UPDATE');
  });

  it('should convert terms from JSON', () => {
    expect(QuerySourceVector.termFromJson({ type: 'iri', value: 'http://ex/s' }, DF).value)
      .toBe('http://ex/s');
    expect(QuerySourceVector.termFromJson({ type: 'uri', value: 'http://ex/u' }, DF).value)
      .toBe('http://ex/u');
    expect(QuerySourceVector.termFromJson({ type: 'literal', value: 'x', lang: 'en' }, DF).value)
      .toBe('x');
    expect(QuerySourceVector.termFromJson({ type: 'literal', value: 'plain' }, DF).value)
      .toBe('plain');
    expect(QuerySourceVector.termFromJson({ type: 'bnode', value: 'b0' }, DF).termType)
      .toBe('BlankNode');
    expect(QuerySourceVector.termFromJson({
      type: 'literal',
      value: '1',
      datatype: 'http://www.w3.org/2001/XMLSchema#integer',
    }, DF).termType).toBe('Literal');
    expect(() => QuerySourceVector.termFromJson({ type: 'unknown' }, DF)).toThrow('Unsupported term JSON');
  });

  it('should read a stream to string from both Buffer and string chunks', async() => {
    await expect(QuerySourceVector.readStreamToString(Readable.from([ Buffer.from('he'), Buffer.from('llo') ])))
      .resolves.toBe('hello');
    await expect(QuerySourceVector.readStreamToString(Readable.from([ 'wor', 'ld' ], { objectMode: true })))
      .resolves.toBe('world');
  });

  it('should convert RDF terms to JSON', () => {
    expect(QuerySourceVector.termOrVarToJson(DF.variable('s'))).toBe('s');
    expect(QuerySourceVector.termOrVarToJson(DF.namedNode('http://ex/s')))
      .toEqual({ type: 'iri', value: 'http://ex/s' });
    expect(QuerySourceVector.termOrVarToJson(DF.blankNode('b0')))
      .toEqual({ type: 'bnode', value: 'b0' });
    expect(QuerySourceVector.termOrVarToJson(DF.literal('x', 'en')))
      .toEqual({ type: 'literal', value: 'x', lang: 'en' });
    expect(QuerySourceVector.termOrVarToJson(DF.literal('1', DF.namedNode('http://www.w3.org/2001/XMLSchema#integer'))))
      .toEqual({
        type: 'literal',
        value: '1',
        datatype: 'http://www.w3.org/2001/XMLSchema#integer',
      });
    expect(QuerySourceVector.termOrVarToJson(DF.literal('plain')))
      .toEqual({ type: 'literal', value: 'plain' });
    expect(() => QuerySourceVector.termOrVarToJson(<any> { termType: 'DefaultGraph' })).toThrow('Unsupported RDF term');
  });

  it('should ignore joinBindings read errors when building the request body', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const failingBindings = {
      [Symbol.asyncIterator]() {
        return {
          next: async() => {
            throw new Error('stream failed');
          },
        };
      },
    };
    const body = await QuerySourceVector.buildRequestBody(
      pattern,
      [ DF.variable('s') ],
      {
        bindings: <any> failingBindings,
        metadata: {
          state: new MetadataValidationState(),
          variables: [{ variable: DF.variable('s'), canBeUndef: false }],
          cardinality: { type: 'exact', value: 1 },
        },
      },
      DF,
    );
    expect(body.values).toBeUndefined();
  });

  it('should build request body with joinBindings', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const binding = BF.bindings([[ DF.variable('s'), DF.namedNode('http://ex/s') ]]);
    const body = await QuerySourceVector.buildRequestBody(
      pattern,
      [ DF.variable('s') ],
      {
        bindings: <any> new ArrayIterator([ binding ], { autoStart: false }),
        metadata: {
          state: new MetadataValidationState(),
          variables: [{ variable: DF.variable('s'), canBeUndef: false }],
          cardinality: { type: 'exact', value: 1 },
        },
      },
      DF,
      5,
    );
    expect(body.k).toBe(5);
    expect(body.values).toEqual([{ s: { type: 'iri', value: 'http://ex/s' }}]);
  });

  it('should build request body with adaptive multipliers as a string', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const body = await QuerySourceVector.buildRequestBody(
      pattern,
      [ DF.variable('s') ],
      undefined,
      DF,
      undefined,
      '1, 10, bad, 0, 100',
      0.99,
    );
    expect(body.adaptive_multipliers).toEqual([ 1, 10, 100 ]);
    expect(body.adaptive_jaccard).toBe(0.99);
    expect(body.k).toBeUndefined();
  });

  it('should build request body with adaptive multipliers as an array', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const body = await QuerySourceVector.buildRequestBody(
      pattern,
      [ DF.variable('s') ],
      undefined,
      DF,
      3,
      [ 1, 10 ],
      undefined,
    );
    expect(body.k).toBe(3);
    expect(body.adaptive_multipliers).toEqual([ 1, 10 ]);
    expect(body.adaptive_jaccard).toBeUndefined();
  });

  it('should omit adaptive fields when null', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const body = await QuerySourceVector.buildRequestBody(
      pattern,
      [ DF.variable('s') ],
      undefined,
      DF,
      undefined,
      null,
      null,
    );
    expect(body.adaptive_multipliers).toBeUndefined();
    expect(body.adaptive_jaccard).toBeUndefined();
  });

  it('should forward adaptive options in queryBindings POST body', async() => {
    const adaptiveCtx = new ActionContext({
      [KeysInitQuery.dataFactory.name]: DF,
      '@comunica/actor-query-source-identify-hypermedia-vector:adaptiveMultipliers': '1,10',
      '@comunica/actor-query-source-identify-hypermedia-vector:adaptiveJaccard': 0.95,
    });
    const adaptiveSource = new QuerySourceVector(url, adaptiveCtx, mediatorHttp, DF, AF, BF);
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(adaptiveSource.queryBindings(pattern, adaptiveCtx)).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
    const body = JSON.parse(mediatorHttp.mediate.mock.calls.at(-1)[0].init.body);
    expect(body.adaptive_multipliers).toEqual([ 1, 10 ]);
    expect(body.adaptive_jaccard).toBe(0.95);
    expect(body.k).toBeUndefined();
  });

  it('should omit null terms in values rows when building the request body', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const binding = BF.bindings([[ DF.variable('s'), DF.namedNode('http://ex/s') ]]);
    const body = await QuerySourceVector.buildRequestBody(
      pattern,
      [ DF.variable('s'), DF.variable('p') ],
      {
        bindings: <any> new ArrayIterator([ binding ], { autoStart: false }),
        metadata: {
          state: new MetadataValidationState(),
          variables: [
            { variable: DF.variable('s'), canBeUndef: false },
            { variable: DF.variable('p'), canBeUndef: false },
          ],
          cardinality: { type: 'exact', value: 1 },
        },
      },
      DF,
    );
    expect((<any[]> body.values)[0].p).toBeNull();
  });

  it('should extract patterns and values from operations', () => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    expect(QuerySourceVector.extractSinglePattern(pattern)?.type).toBe(Algebra.Types.PATTERN);
    const values = AF.createValues([ DF.variable('s') ], [{ s: DF.namedNode('http://ex/s') }]);
    const join = AF.createJoin([ values, pattern ], false);
    expect(QuerySourceVector.extractValuesFromOperation(join)?.type).toBe(Algebra.Types.VALUES);
    const joinValuesSecond = AF.createJoin([ pattern, values ], false);
    expect(QuerySourceVector.extractValuesFromOperation(joinValuesSecond)?.type).toBe(Algebra.Types.VALUES);
  });

  it('should query bindings with VALUES in a join', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const values = AF.createValues([ DF.variable('s') ], <any>[
      { '?s': DF.namedNode('http://ex/s1') },
      { s: DF.blankNode('b0') },
    ]);
    const join = AF.createJoin([ values, pattern ], false);
    await expect(source.queryBindings(join, ctx)).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
    const body = JSON.parse(mediatorHttp.mediate.mock.calls.at(-1)[0].init.body);
    expect(body.values).toHaveLength(2);
    expect(body.values[0].s).toEqual({ type: 'iri', value: 'http://ex/s1' });
    expect(body.values[1].s).toEqual({ type: 'bnode', value: 'b0' });
  });

  it('should continue when joinBindings materialization fails', async() => {
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    const failingBindings = {
      [Symbol.asyncIterator]() {
        return {
          next: async() => {
            throw new Error('stream failed');
          },
        };
      },
    };
    await expect(source.queryBindings(pattern, ctx, {
      joinBindings: {
        bindings: <any> failingBindings,
        metadata: {
          state: new MetadataValidationState(),
          variables: [{ variable: DF.variable('s'), canBeUndef: false }],
          cardinality: { type: 'exact', value: 1 },
        },
      },
    })).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
  });

  it('should query bindings with joinBindings option', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const binding = BF.bindings([[ DF.variable('s'), DF.namedNode('http://ex/s') ]]);
    await expect(source.queryBindings(pattern, ctx, {
      joinBindings: {
        bindings: <any> new ArrayIterator([ binding ], { autoStart: false }),
        metadata: {
          state: new MetadataValidationState(),
          variables: [{ variable: DF.variable('s'), canBeUndef: false }],
          cardinality: { type: 'exact', value: 1 },
        },
      },
    })).toEqualBindingsStream([
      BF.bindings([[ DF.variable('p'), DF.namedNode('http://ex/p1') ]]),
    ]);
  });

  it('should throw when the vector endpoint returns an empty body', async() => {
    mediateSpy.mockResolvedValueOnce({ body: null });
    const pattern = AF.createPattern(DF.namedNode('http://ex/s'), DF.variable('p'), DF.namedNode('http://ex/o'));
    await expect(source.queryBindings(pattern, ctx).toArray()).rejects
      .toThrow('Vector endpoint returned empty body');
  });

  it('should throw when no pattern is found in the operation', async() => {
    await expect(source.queryBindings(AF.createNop(), ctx).toArray()).rejects
      .toThrow('Vector source only supports single triple pattern operations');
  });

  it('should estimate cardinality', async() => {
    await expect(source.estimateOperationCardinality(
      AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o')),
    )).resolves.toEqual({ type: 'estimate', value: Number.POSITIVE_INFINITY });
  });

  it('should add bindings to operation', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const binding = BF.bindings([[ DF.variable('s'), DF.namedNode('http://ex/s') ]]);
    const op = await QuerySourceVector.addBindingsToOperation(AF, pattern, {
      bindings: <any> new ArrayIterator([ binding ], { autoStart: false }),
      metadata: {
        state: new MetadataValidationState(),
        variables: [{ variable: DF.variable('s'), canBeUndef: false }],
        cardinality: { type: 'exact', value: 1 },
      },
    });
    expect(op.type).toBe(Algebra.Types.JOIN);
  });

  it('should return the operation unchanged when joinBindings are empty', async() => {
    const pattern = AF.createPattern(DF.variable('s'), DF.variable('p'), DF.variable('o'));
    const op = await QuerySourceVector.addBindingsToOperation(AF, pattern, {
      bindings: <any> new ArrayIterator([], { autoStart: false }),
      metadata: {
        state: new MetadataValidationState(),
        variables: [{ variable: DF.variable('s'), canBeUndef: false }],
        cardinality: { type: 'exact', value: 0 },
      },
    });
    expect(op).toBe(pattern);
  });
});
