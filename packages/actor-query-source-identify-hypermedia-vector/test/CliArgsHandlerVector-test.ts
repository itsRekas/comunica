import { CliArgsHandlerVector } from '../lib/CliArgsHandlerVector';

describe('CliArgsHandlerVector', () => {
  const handler = new CliArgsHandlerVector();

  it('should be a CliArgsHandlerVector constructor', () => {
    expect(handler).toBeInstanceOf(CliArgsHandlerVector);
  });

  it('should populate yargs with k option', () => {
    const options = jest.fn().mockReturnThis();
    handler.populateYargs(<any> { options });
    expect(options).toHaveBeenCalledWith({
      k: {
        type: 'number',
        describe: 'Limit (k) for vector similarity search results',
        default: 10,
        group: 'Vector options:',
      },
    });
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
});
