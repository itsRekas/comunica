import type { ICliArgsHandler } from '@comunica/types';
import type { Argv } from 'yargs';

/**
 * CLI arguments handler that handles options for vector sources.
 */
export class CliArgsHandlerVector implements ICliArgsHandler {
  public populateYargs(argumentsBuilder: Argv<any>): Argv<any> {
    return argumentsBuilder
      .options({
        k: {
          type: 'number',
          describe: 'Limit (k) for vector similarity search results',
          default: 10,
          group: 'Vector options:',
        },
      });
  }

  public async handleArgs(args: Record<string, any>, context: Record<string, any>): Promise<void> {
    if (args.k !== undefined) {
      context['@comunica/actor-query-source-identify-hypermedia-vector:k'] = args.k;
    }
  }
}
