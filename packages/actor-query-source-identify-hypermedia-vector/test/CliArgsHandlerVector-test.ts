import { CliArgsHandlerVector } from '../lib/CliArgsHandlerVector';

describe('CliArgsHandlerVector', () => {
  const handler = new CliArgsHandlerVector();

  const vectorYargsOptions = {
    k: {
      type: 'number',
      describe: 'Limit (k) for vector similarity search results',
      default: 10,
      group: 'Vector options:',
    },
    adaptiveMultipliers: {
      alias: 'adaptive-multipliers',
      type: 'string',
      describe: 'Comma-separated k ladder multipliers for adaptive vector search (per BGP)',
      group: 'Vector options:',
    },
    adaptiveJaccard: {
      alias: 'adaptive-jaccard',
      type: 'number',
      describe: 'Jaccard stability threshold for adaptive vector search',
      group: 'Vector options:',
    },
    http: {
      type: 'boolean',
      describe: 'Use HTTP JSON vector endpoint (baseline pipeline)',
      group: 'Vector options:',
    },
    grpc: {
      type: 'boolean',
      describe: 'Use gRPC streaming vector endpoint',
      group: 'Vector options:',
    },
  };

  it('should be a CliArgsHandlerVector constructor', () => {
    expect(handler).toBeInstanceOf(CliArgsHandlerVector);
  });

  it('should populate yargs with vector options', () => {
    const options = jest.fn().mockReturnThis();
    handler.populateYargs(<any> { options });
    expect(options).toHaveBeenCalledWith(vectorYargsOptions);
  });

  it('should handle k in context', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({ k: 42 }, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:k']).toBe(42);
  });

  it('should not set k when undefined', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({}, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:k']).toBeUndefined();
  });

  it('should handle adaptive multipliers in context', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({ adaptiveMultipliers: '1,10,100' }, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveMultipliers'])
      .toBe('1,10,100');
  });

  it('should handle adaptive jaccard in context', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({ adaptiveJaccard: 0.99 }, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveJaccard'])
      .toBe(0.99);
  });

  it('should handle http transport in context', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({ http: true }, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:transport']).toBe('http');
  });

  it('should handle grpc transport in context', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({ grpc: true }, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:transport']).toBe('grpc');
  });

  it('should reject both http and grpc', async() => {
    await expect(handler.handleArgs({ http: true, grpc: true }, {})).rejects.toThrow(
      'Cannot use both --http and --grpc',
    );
  });

  it('should not set adaptive options when undefined', async() => {
    const context: Record<string, unknown> = {};
    await handler.handleArgs({}, context);
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveMultipliers'])
      .toBeUndefined();
    expect(context['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveJaccard'])
      .toBeUndefined();
  });
});
