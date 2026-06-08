import { Readable } from 'node:stream';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { ArrayIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';

import type { IVectorGrpcClient } from '../lib/VectorGrpcClient';
import {
  KEY_VECTOR_TRANSPORT,
  closeAllChannels,
  jsonBodyToGrpcRequest,
  parseGrpcTarget,
  queryBindingsStreamViaGrpc,
  queryBindingsViaGrpc,
  resolveTransport,
  resolveVectorEndpoint,
  termToProto,
  variableNamesFromVars,
  VectorGrpcClient,
} from '../lib/VectorGrpcClient';

const mockQueryPattern = jest.fn();
const mockClose = jest.fn();
const mockServiceConstructor = jest.fn();

jest.mock<typeof import('@grpc/grpc-js')>('@grpc/grpc-js', () => <typeof import('@grpc/grpc-js')><any>({
  loadPackageDefinition: jest.fn(() => ({
    vector: {
      v1: {
        VectorPatternService: function VectorPatternService(this: any, ...args: unknown[]) {
          mockServiceConstructor(...args);
          this.queryPattern = (...callArgs: unknown[]) => mockQueryPattern(...callArgs);
          this.close = mockClose;
        },
      },
    },
  })),
  credentials: {
    createInsecure: jest.fn(() => ({})),
  },
}));

jest.mock<typeof import('@grpc/proto-loader')>('@grpc/proto-loader', () => <typeof import('@grpc/proto-loader')><any>({
  loadSync: jest.fn(() => ({})),
}));

const DF = new DataFactory();
const BF = new BindingsFactory(DF);

/** A Node object-mode Readable that emits the given events then ends (what `wrap` expects). */
function readableOf(events: Record<string, unknown>[]): Readable {
  return Readable.from(events, { objectMode: true });
}

/** A Readable that errors out asynchronously (simulates a transport/RPC failure). */
function erroringReadable(error: Error): Readable {
  const stream = new Readable({ objectMode: true, read() {} });
  setImmediate(() => stream.destroy(error));
  return stream;
}

describe('VectorGrpcClient helpers', () => {
  it('should resolve transport from context or URL', () => {
    expect(resolveTransport({ [KEY_VECTOR_TRANSPORT]: 'grpc' }, 'http://x')).toBe('grpc');
    expect(resolveTransport({ [KEY_VECTOR_TRANSPORT]: 'http' }, 'grpc://x')).toBe('http');
    expect(resolveTransport({}, 'grpc://127.0.0.1:50051')).toBe('grpc');
    expect(resolveTransport({}, 'http://localhost:2222/vector')).toBe('http');
  });

  it('should normalize http and grpc endpoints', () => {
    expect(resolveVectorEndpoint('http', 'localhost:2222')).toBe('http://localhost:2222/vector');
    expect(resolveVectorEndpoint('http', 'http://localhost:2222/')).toBe('http://localhost:2222/vector');
    expect(resolveVectorEndpoint('http', 'http://localhost:2222/vector')).toBe('http://localhost:2222/vector');
    expect(resolveVectorEndpoint('http', 'https://localhost:2222')).toBe('https://localhost:2222/vector');
    expect(resolveVectorEndpoint('http', 'example.org/path')).toBe('http://example.org/path');
    expect(resolveVectorEndpoint('grpc', '127.0.0.1:50051')).toBe('grpc://127.0.0.1:50051');
    expect(resolveVectorEndpoint('grpc', 'grpc://127.0.0.1:50051')).toBe('grpc://127.0.0.1:50051');
  });

  it('should reject mismatched transport and URL schemes', () => {
    expect(() => resolveVectorEndpoint('http', 'grpc://127.0.0.1:50051')).toThrow(
      'Cannot use --http with a grpc:// source URL',
    );
    expect(() => resolveVectorEndpoint('grpc', 'http://localhost:2222/vector')).toThrow(
      'Cannot use --grpc with an http:// source URL',
    );
  });

  it('should parse grpc targets with default port', () => {
    expect(parseGrpcTarget('grpc://127.0.0.1:50051')).toBe('127.0.0.1:50051');
    expect(parseGrpcTarget('127.0.0.1')).toBe('127.0.0.1:50051');
    expect(parseGrpcTarget('host:9999')).toBe('host:9999');
  });

  it('should collect variable names from vars array', () => {
    expect(variableNamesFromVars('not-array')).toEqual(new Set());
    expect(variableNamesFromVars([ '?X', 'Y' ])).toEqual(new Set([ 'X', 'Y' ]));
  });

  it('should encode terms for protobuf', () => {
    const varNames = variableNamesFromVars([ 'X' ]);
    expect(termToProto(null, varNames)).toEqual({});
    expect(termToProto('?X', varNames)).toEqual({ type: 'variable', value: 'X' });
    expect(termToProto('http://ex/s', varNames)).toEqual({ type: 'iri', value: 'http://ex/s' });
    expect(termToProto('X', varNames)).toEqual({ type: 'variable', value: 'X' });
    expect(termToProto({ termType: 'Variable', value: '?Z' }, varNames))
      .toEqual({ type: 'variable', value: 'Z' });
    expect(termToProto({ type: 'variable', value: '?W' }, varNames))
      .toEqual({ type: 'variable', value: 'W' });
    expect(termToProto({ type: 'variable' }, varNames))
      .toEqual({ type: 'variable', value: '' });
    expect(termToProto({
      type: 'literal',
      value: 'hello',
      lang: 'en',
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    }, varNames)).toEqual({
      type: 'literal',
      value: 'hello',
      lang: 'en',
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    });
  });

  it('should build grpc request bodies from JSON', () => {
    const body = jsonBodyToGrpcRequest({
      pattern: {
        subject: 'X',
        predicate: { type: 'iri', value: 'http://ex/p' },
        object: { type: 'iri', value: 'http://ex/o' },
      },
      vars: [ 'X' ],
      values: [{ X: 'http://ex/s' }],
      k: 1200,
      adaptive_multipliers: [ 1, 10 ],
      adaptive_jaccard: 0.99,
    });
    expect((<Record<string, string>> (<any> body.pattern).subject).type).toBe('variable');
    expect((<any[]> body.values)[0].bindings.X).toEqual({ type: 'iri', value: 'http://ex/s' });
    expect(body.k).toBe(1200);
    expect(body.adaptiveMultipliers).toEqual([ 1, 10 ]);
    expect(body.adaptiveJaccard).toBe(0.99);

    const minimal = jsonBodyToGrpcRequest({
      pattern: { subject: 'http://ex/s', predicate: 'http://ex/p', object: 'http://ex/o' },
    });
    expect(minimal.vars).toEqual([]);
    expect(minimal.values).toEqual([]);
  });
});

describe('VectorGrpcClient channel cache', () => {
  beforeEach(() => {
    closeAllChannels();
    mockQueryPattern.mockReset();
    mockClose.mockReset();
    mockServiceConstructor.mockReset();
  });

  it('should reuse one channel per target and create distinct channels per target', () => {
    // eslint-disable-next-line no-new
    new VectorGrpcClient('127.0.0.1:50051');
    // eslint-disable-next-line no-new
    new VectorGrpcClient('127.0.0.1:50051');
    expect(mockServiceConstructor).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line no-new
    new VectorGrpcClient('other-host:9999');
    expect(mockServiceConstructor).toHaveBeenCalledTimes(2);
  });

  it('should close and clear all cached channels', () => {
    // eslint-disable-next-line no-new
    new VectorGrpcClient('host-a:1');
    // eslint-disable-next-line no-new
    new VectorGrpcClient('host-b:2');
    closeAllChannels();
    expect(mockClose).toHaveBeenCalledTimes(2);
    // A new construction after clearing rebuilds the channel.
    mockServiceConstructor.mockClear();
    // eslint-disable-next-line no-new
    new VectorGrpcClient('host-a:1');
    expect(mockServiceConstructor).toHaveBeenCalledTimes(1);
  });

  it('should bound the cache by dropping channels when it grows too large', () => {
    for (let i = 0; i < 32; i++) {
      // eslint-disable-next-line no-new
      new VectorGrpcClient(`evict-${i}:1`);
    }
    expect(mockServiceConstructor).toHaveBeenCalledTimes(32);
    // The 33rd distinct target trips the bound and closes the accumulated channels first.
    // eslint-disable-next-line no-new
    new VectorGrpcClient('evict-32:1');
    expect(mockClose).toHaveBeenCalledTimes(32);
    expect(mockServiceConstructor).toHaveBeenCalledTimes(33);
  });
});

describe('VectorGrpcClient.queryPatternStream', () => {
  beforeEach(() => {
    closeAllChannels();
    mockQueryPattern.mockReset();
    mockClose.mockReset();
    mockServiceConstructor.mockReset();
  });

  it('should stream single rows from grpc responses', async() => {
    mockQueryPattern.mockReturnValueOnce(readableOf([
      { row: { bindings: { p: { type: 'iri', value: 'http://ex/p1' }}}},
    ]));
    const client = new VectorGrpcClient('127.0.0.1:50051');
    const rows = await client.queryPatternStream({ pattern: {}, vars: [ 'p' ]}).toArray();
    expect(rows).toEqual([{ p: { type: 'iri', value: 'http://ex/p1' }}]);
  });

  it('should stream batched rows and skip empty bindings', async() => {
    mockQueryPattern.mockReturnValueOnce(readableOf([
      {
        rowBatch: {
          rows: [
            { bindings: { p: { type: 'iri', value: 'http://ex/p1' }}},
            { bindings: { q: {}}},
            { bindings: { r: { type: 'literal', value: 'x', lang: 'en' }}},
          ],
        },
      },
    ]));
    const client = new VectorGrpcClient('127.0.0.1:50051');
    const rows = await client.queryPatternStream({ pattern: {}, vars: []}).toArray();
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({});
    expect((<any> rows[2]).r).toEqual({ type: 'literal', value: 'x', lang: 'en', datatype: undefined });
  });

  it('should ignore metadata and done events', async() => {
    mockQueryPattern.mockReturnValueOnce(readableOf([
      { metadata: { vars: [ 'p' ]}},
      { row: { bindings: { p: { type: 'iri', value: 'http://ex/p1' }}}},
      { done: { totalRows: 1 }},
    ]));
    const client = new VectorGrpcClient('127.0.0.1:50051');
    const rows = await client.queryPatternStream({ pattern: {}, vars: [ 'p' ]}).toArray();
    expect(rows).toEqual([{ p: { type: 'iri', value: 'http://ex/p1' }}]);
  });

  it('should reject in-band error events', async() => {
    mockQueryPattern.mockReturnValueOnce(readableOf([{ error: { message: 'pattern failed' }}]));
    const client = new VectorGrpcClient('127.0.0.1:50051');
    await expect(client.queryPatternStream({ pattern: {}, vars: []}).toArray())
      .rejects.toThrow('pattern failed');
  });

  it('should propagate transport stream errors', async() => {
    mockQueryPattern.mockReturnValueOnce(erroringReadable(new Error('rpc down')));
    const client = new VectorGrpcClient('127.0.0.1:50051');
    await expect(client.queryPatternStream({ pattern: {}, vars: []}).toArray())
      .rejects.toThrow('rpc down');
  });

  it('should cancel the rpc when the consumer stops early', async() => {
    const cancel = jest.fn();
    const stream = new Readable({ objectMode: true, read() {} });
    (<any> stream).cancel = cancel;
    mockQueryPattern.mockReturnValueOnce(stream);
    const client = new VectorGrpcClient('127.0.0.1:50051');
    const it = client.queryPatternStream({ pattern: {}, vars: [ 'p' ]});
    stream.push({ rowBatch: { rows: [{ bindings: { p: { type: 'iri', value: 'http://ex/p1' }}}]}});
    const first = await new Promise(resolve => it.once('data', resolve));
    expect(first).toEqual({ p: { type: 'iri', value: 'http://ex/p1' }});
    it.destroy();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('queryBindingsStreamViaGrpc / queryBindingsViaGrpc', () => {
  beforeEach(() => {
    closeAllChannels();
    mockQueryPattern.mockReset();
    mockClose.mockReset();
    mockServiceConstructor.mockReset();
  });

  it('should convert streamed rows to bindings', async() => {
    const mockClient: IVectorGrpcClient = {
      queryPatternStream: () => new ArrayIterator<Record<string, unknown>>([
        { s: { type: 'iri', value: 'http://ex/s' }},
        { n: { type: 'literal', value: 'hi', lang: 'en' }},
        { c: { type: 'literal', value: '1', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }},
        { b: { type: 'bnode', value: 'b0' }},
        { u: { type: 'uri', value: 'http://ex/u' }},
        { plain: { type: 'literal', value: 'plain' }},
      ], { autoStart: false }),
    };
    const bindings = await queryBindingsViaGrpc(
      'grpc://127.0.0.1:50051',
      { pattern: {}, vars: [ 's', 'n', 'c', 'b', 'u' ]},
      DF,
      BF,
      () => mockClient,
    );
    expect(bindings).toHaveLength(6);
    expect(bindings[0].get(DF.variable('s'))?.value).toBe('http://ex/s');
    expect(bindings[1].get(DF.variable('n'))?.value).toBe('hi');
    expect(bindings[2].get(DF.variable('c'))?.termType).toBe('Literal');
    expect(bindings[3].get(DF.variable('b'))?.termType).toBe('BlankNode');
  });

  it('should use the default grpc client factory (buffered)', async() => {
    mockQueryPattern.mockReturnValueOnce(readableOf([
      { row: { bindings: { p: { type: 'iri', value: 'http://ex/p-default' }}}},
    ]));
    const bindings = await queryBindingsViaGrpc(
      'grpc://127.0.0.1:50051',
      { pattern: {}, vars: [ 'p' ]},
      DF,
      BF,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].get(DF.variable('p'))?.value).toBe('http://ex/p-default');
  });

  it('should stream bindings with the default grpc client factory', async() => {
    mockQueryPattern.mockReturnValueOnce(readableOf([
      { row: { bindings: { p: { type: 'iri', value: 'http://ex/p-stream' }}}},
    ]));
    const bindings = await queryBindingsStreamViaGrpc(
      'grpc://127.0.0.1:50051',
      { pattern: {}, vars: [ 'p' ]},
      DF,
      BF,
    ).toArray();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].get(DF.variable('p'))?.value).toBe('http://ex/p-stream');
  });

  it('should error on unsupported term JSON', async() => {
    const mockClient: IVectorGrpcClient = {
      queryPatternStream: () => new ArrayIterator<Record<string, unknown>>([
        { bad: { type: 'unknown', value: 'x' }},
      ], { autoStart: false }),
    };
    await expect(queryBindingsViaGrpc(
      'grpc://127.0.0.1:50051',
      { pattern: {}, vars: [ 'bad' ]},
      DF,
      BF,
      () => mockClient,
    )).rejects.toThrow('Unsupported term JSON');
  });
});
