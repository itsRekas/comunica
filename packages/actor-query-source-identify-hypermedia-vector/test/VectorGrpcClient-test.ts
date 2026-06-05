import { EventEmitter } from 'node:events';
import { BindingsFactory } from '@comunica/utils-bindings-factory';
import { DataFactory } from 'rdf-data-factory';

import {
  KEY_VECTOR_TRANSPORT,
  jsonBodyToGrpcRequest,
  parseGrpcTarget,
  queryBindingsViaGrpc,
  resolveTransport,
  resolveVectorEndpoint,
  termToProto,
  variableNamesFromVars,
  VectorGrpcClient,
} from '../lib/VectorGrpcClient';

const mockQueryPattern = jest.fn();

jest.mock<typeof import('@grpc/grpc-js')>('@grpc/grpc-js', () => <typeof import('@grpc/grpc-js')><any>({
  loadPackageDefinition: jest.fn(() => ({
    vector: {
      v1: {
        VectorPatternService: jest.fn().mockImplementation(() => ({
          queryPattern: (...args: unknown[]) => mockQueryPattern(...args),
        })),
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

function scheduleStream(
  events: Record<string, unknown>[],
  opts: { streamError?: Error } = {},
): EventEmitter {
  const stream = new EventEmitter();
  mockQueryPattern.mockReturnValueOnce(stream);
  setImmediate(() => {
    if (opts.streamError) {
      stream.emit('error', opts.streamError);
      return;
    }
    for (const event of events) {
      stream.emit('data', event);
    }
    stream.emit('end');
  });
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

describe('VectorGrpcClient', () => {
  beforeEach(() => {
    mockQueryPattern.mockReset();
  });

  it('should reuse cached proto package across clients', () => {
    const client1 = new VectorGrpcClient('127.0.0.1:50051');
    const client2 = new VectorGrpcClient('127.0.0.1:50051');
    expect(client1).toBeDefined();
    expect(client2).toBeDefined();
  });

  it('should stream single rows from grpc responses', async() => {
    scheduleStream([
      { row: { bindings: { p: { type: 'iri', value: 'http://ex/p1' }}}},
    ]);
    const rows: Record<string, unknown>[] = [];
    const client = new VectorGrpcClient('127.0.0.1:50051');
    await client.queryPattern({ pattern: {}, vars: [ 'p' ]}, row => rows.push(row));
    expect(rows).toEqual([{ p: { type: 'iri', value: 'http://ex/p1' }}]);
  });

  it('should stream batched rows and skip empty bindings', async() => {
    scheduleStream([
      {
        rowBatch: {
          rows: [
            { bindings: { p: { type: 'iri', value: 'http://ex/p1' }}},
            { bindings: { q: {}}},
            { bindings: { r: { type: 'literal', value: 'x', lang: 'en' }}},
          ],
        },
      },
    ]);
    const rows: Record<string, unknown>[] = [];
    const client = new VectorGrpcClient('127.0.0.1:50051');
    await client.queryPattern({ pattern: {}, vars: []}, row => rows.push(row));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({});
    expect(rows[2].r).toEqual({ type: 'literal', value: 'x', lang: 'en', datatype: undefined });
  });

  it('should reject grpc error events and stream errors', async() => {
    scheduleStream([{ error: { message: 'pattern failed' }}]);
    const client = new VectorGrpcClient('127.0.0.1:50051');
    await expect(client.queryPattern({ pattern: {}, vars: []}, () => undefined))
      .rejects.toThrow('pattern failed');

    scheduleStream([], { streamError: new Error('rpc down') });
    await expect(client.queryPattern({ pattern: {}, vars: []}, () => undefined))
      .rejects.toThrow('rpc down');
  });
});

describe('queryBindingsViaGrpc', () => {
  it('should convert streamed rows to bindings', async() => {
    const mockClient = {
      queryPattern: async(
        _req: Record<string, unknown>,
        onRow: (row: Record<string, unknown>) => void,
      ) => {
        onRow({ s: { type: 'iri', value: 'http://ex/s' }});
        onRow({ n: { type: 'literal', value: 'hi', lang: 'en' }});
        onRow({ c: { type: 'literal', value: '1', datatype: 'http://www.w3.org/2001/XMLSchema#integer' }});
        onRow({ b: { type: 'bnode', value: 'b0' }});
        onRow({ u: { type: 'uri', value: 'http://ex/u' }});
        onRow({ plain: { type: 'literal', value: 'plain' }});
      },
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

  it('should use the default grpc client factory', async() => {
    scheduleStream([
      { row: { bindings: { p: { type: 'iri', value: 'http://ex/p-default' }}}},
    ]);
    const bindings = await queryBindingsViaGrpc(
      'grpc://127.0.0.1:50051',
      { pattern: {}, vars: [ 'p' ]},
      DF,
      BF,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].get(DF.variable('p'))?.value).toBe('http://ex/p-default');
  });

  it('should throw on unsupported term JSON', async() => {
    const mockClient = {
      queryPattern: async(
        _req: Record<string, unknown>,
        onRow: (row: Record<string, unknown>) => void,
      ) => {
        onRow({ bad: { type: 'unknown', value: 'x' }});
      },
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
