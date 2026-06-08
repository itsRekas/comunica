import type { Bindings, ComunicaDataFactory } from '@comunica/types';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type * as RDF from '@rdfjs/types';
import type { AsyncIterator } from 'asynciterator';
import { wrap } from 'asynciterator';

export const KEY_VECTOR_TRANSPORT = '@comunica/actor-query-source-identify-hypermedia-vector:transport';

// Mirror the server's VECTOR_GRPC_MAX_MESSAGE_BYTES default so large row batches are accepted.
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
// Number of result rows buffered while streaming before backpressure pauses the gRPC call.
const STREAM_BUFFER_SIZE = 128;
// Safety bound: a single endpoint is expected, but guard against unbounded channel growth.
const MAX_CACHED_CHANNELS = 32;

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

type GrpcPatternClient = {
  queryPattern: (
    request: Record<string, unknown>,
  ) => grpc.ClientReadableStream<Record<string, unknown>>;
  close: () => void;
};

type ProtoRoot = {
  vector: {
    v1: {
      VectorPatternService: new(
        address: string,
        credentials: grpc.ChannelCredentials,
        options?: Record<string, unknown>,
      ) => GrpcPatternClient;
    };
  };
};

// One long-lived gRPC channel (client) per target, reused across BGPs/queries to
// avoid a TCP + HTTP/2 handshake on every request.
const clientCache = new Map<string, GrpcPatternClient>();

let beforeExitRegistered = false;

function registerBeforeExitHook(): void {
  if (!beforeExitRegistered) {
    beforeExitRegistered = true;
    process.once('beforeExit', closeAllChannels);
  }
}

function buildClient(target: string): GrpcPatternClient {
  const proto = <ProtoRoot> <unknown> loadProto();
  const Service = proto.vector.v1.VectorPatternService;
  return new Service(target, grpc.credentials.createInsecure(), {
    'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
    'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
    'grpc.keepalive_permit_without_calls': 1,
  });
}

function getCachedClient(target: string): GrpcPatternClient {
  let client = clientCache.get(target);
  if (!client) {
    // Single endpoint is expected; if many distinct targets ever appear, drop the
    // accumulated channels wholesale rather than growing the cache without bound.
    if (clientCache.size >= MAX_CACHED_CHANNELS) {
      closeAllChannels();
    }
    client = buildClient(target);
    clientCache.set(target, client);
  }
  registerBeforeExitHook();
  return client;
}

/** Close and drop all cached gRPC channels (for deterministic shutdown and tests). */
export function closeAllChannels(): void {
  for (const client of clientCache.values()) {
    client.close();
  }
  clientCache.clear();
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
  queryPatternStream: (
    request: Record<string, unknown>,
  ) => AsyncIterator<Record<string, unknown>>;
}

export class VectorGrpcClient implements IVectorGrpcClient {
  private readonly client: GrpcPatternClient;

  public constructor(endpoint: string) {
    this.client = getCachedClient(parseGrpcTarget(endpoint));
  }

  /**
   * Start a server-streaming QueryPattern RPC and expose the result rows as a lazy
   * AsyncIterator. Rows (and row batches) are flattened; metadata/done events are dropped;
   * in-band error events and transport errors surface as an iterator 'error'.
   * Backpressure flows from the consumer to the gRPC call via the iterator buffer.
   */
  public queryPatternStream(request: Record<string, unknown>): AsyncIterator<Record<string, unknown>> {
    const grpcReq = jsonBodyToGrpcRequest(request);
    const call = this.client.queryPattern(grpcReq);

    const rows = wrap<Record<string, unknown>>(call, { maxBufferSize: STREAM_BUFFER_SIZE })
      .transform<Record<string, unknown>>({
        maxBufferSize: STREAM_BUFFER_SIZE,
        transform(event: Record<string, unknown>, done: () => void, push: (row: Record<string, unknown>) => void) {
          const error = <{ message?: string } | undefined> event.error;
          if (error?.message) {
            rows.destroy(new Error(error.message));
            done();
            return;
          }
          const single = <{ bindings?: Record<string, ITermJson> } | undefined> event.row;
          if (single?.bindings) {
            push(bindingsMapToRow(single.bindings));
          }
          const batch = <{ rows?: { bindings?: Record<string, ITermJson> }[] } | undefined> event.rowBatch;
          if (batch?.rows) {
            for (const batchRow of batch.rows) {
              if (batchRow.bindings) {
                push(bindingsMapToRow(batchRow.bindings));
              }
            }
          }
          done();
        },
      });

    // Cancel the RPC on early teardown (e.g. LIMIT) so the server stops producing.
    // The iterator does NOT emit 'end' on destroy, and grpc-js does NOT cancel on stream
    // destroy, so we hook the call's 'close' (fired by wrap destroying the source). 'status'
    // marks natural completion so we skip a redundant cancel. 'once' handlers auto-remove.
    let rpcSettled = false;
    const markSettled = (): void => {
      rpcSettled = true;
    };
    call.once('status', markSettled);
    call.once('end', markSettled);

    let cancelled = false;
    const cancelIfRunning = (): void => {
      if (!rpcSettled && !cancelled && typeof call.cancel === 'function') {
        cancelled = true;
        try {
          call.cancel();
        } catch {
          // Ignore cancel failures (call may already be torn down).
        }
      }
    };
    call.once('close', cancelIfRunning);
    return rows;
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

/**
 * Stream result bindings from the gRPC vector endpoint as a lazy AsyncIterator.
 * Term conversion errors surface as an iterator 'error' (via destroy).
 */
export function queryBindingsStreamViaGrpc(
  endpoint: string,
  body: Record<string, unknown>,
  df: ComunicaDataFactory,
  bindingsFactory: { bindings: (entries: [RDF.Variable, RDF.Term][]) => Bindings },
  clientFactory: (ep: string) => IVectorGrpcClient = ep => new VectorGrpcClient(ep),
): AsyncIterator<Bindings> {
  const client = clientFactory(endpoint);
  const out = client.queryPatternStream(body).transform<Bindings>({
    transform(row: Record<string, unknown>, done: () => void, push: (binding: Bindings) => void) {
      try {
        const entries = Object.entries(row)
          .map(([ v, t ]) => <[RDF.Variable, RDF.Term]> [ df.variable(v), termFromJson(t, df) ]);
        push(bindingsFactory.bindings(entries));
        done();
      } catch (error) {
        out.destroy(<Error> error);
        done();
      }
    },
  });
  return out;
}

/** Buffered convenience wrapper over {@link queryBindingsStreamViaGrpc}. */
export function queryBindingsViaGrpc(
  endpoint: string,
  body: Record<string, unknown>,
  df: ComunicaDataFactory,
  bindingsFactory: { bindings: (entries: [RDF.Variable, RDF.Term][]) => Bindings },
  clientFactory: (ep: string) => IVectorGrpcClient = ep => new VectorGrpcClient(ep),
): Promise<Bindings[]> {
  return queryBindingsStreamViaGrpc(endpoint, body, df, bindingsFactory, clientFactory).toArray();
}
