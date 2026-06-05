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
      });
  }

  public async handleArgs(args: Record<string, any>, context: Record<string, any>): Promise<void> {
    if (args.http && args.grpc) {
      throw new Error('Cannot use both --http and --grpc');
    }
    if (args.http) {
      context['@comunica/actor-query-source-identify-hypermedia-vector:transport'] = 'http';
    }
    if (args.grpc) {
      context['@comunica/actor-query-source-identify-hypermedia-vector:transport'] = 'grpc';
    }
    if (args.k !== undefined) {
      context['@comunica/actor-query-source-identify-hypermedia-vector:k'] = args.k;
    }
    if (args.adaptiveMultipliers !== undefined) {
      context['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveMultipliers'] =
        args.adaptiveMultipliers;
    }
    if (args.adaptiveJaccard !== undefined) {
      context['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveJaccard'] =
        args.adaptiveJaccard;
    }
  }
}
