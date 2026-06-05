#!/usr/bin/env node
import {
  KEY_VECTOR_TRANSPORT,
  resolveVectorEndpoint,
  type VectorTransport,
} from '@comunica/actor-query-source-identify-hypermedia-vector';
import { runArgsInProcess } from '@comunica/runner-cli';

const argv = process.argv.slice(2);

const sources: { type: 'vector'; value: string }[] = [];
const rest: string[] = [];
let inOptions = false;
let kValue: number | undefined;
let adaptiveMultipliers: string | undefined;
let adaptiveJaccard: number | undefined;
let transportFlag: VectorTransport | undefined;

const filteredArgv: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '-k' || arg === '--k') {
    if (i + 1 < argv.length) {
      kValue = Number.parseInt(argv[i + 1], 10);
      i++;
    }
  } else if (arg === '--adaptive-multipliers') {
    if (i + 1 < argv.length) {
      adaptiveMultipliers = argv[i + 1];
      i++;
    }
  } else if (arg === '--adaptive-jaccard') {
    if (i + 1 < argv.length) {
      adaptiveJaccard = Number.parseFloat(argv[i + 1]);
      i++;
    }
  } else if (arg === '--http') {
    if (transportFlag) {
      throw new Error('Cannot use both --http and --grpc');
    }
    transportFlag = 'http';
  } else if (arg === '--grpc') {
    if (transportFlag) {
      throw new Error('Cannot use both --http and --grpc');
    }
    transportFlag = 'grpc';
  } else {
    filteredArgv.push(arg);
  }
}

for (const arg of filteredArgv) {
  if (!inOptions && !arg.startsWith('-') && !arg.startsWith('{')) {
    const transport = transportFlag ?? (arg.startsWith('grpc://') ? 'grpc' : 'http');
    sources.push({ type: 'vector', value: resolveVectorEndpoint(transport, arg) });
  } else {
    inOptions = true;
    rest.push(arg);
  }
}

const contextData: Record<string, unknown> = { sources };
if (transportFlag) {
  contextData[KEY_VECTOR_TRANSPORT] = transportFlag;
}
if (kValue !== undefined) {
  contextData['@comunica/actor-query-source-identify-hypermedia-vector:k'] = kValue;
}
if (adaptiveMultipliers !== undefined) {
  contextData['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveMultipliers'] =
    adaptiveMultipliers;
}
if (adaptiveJaccard !== undefined) {
  contextData['@comunica/actor-query-source-identify-hypermedia-vector:adaptiveJaccard'] =
    adaptiveJaccard;
}

const contextArg = JSON.stringify(contextData);
process.argv = [ process.argv[0], process.argv[1], contextArg, ...rest ];

// eslint-disable-next-line node/no-path-concat
runArgsInProcess(`${__dirname}/../../..`, `${__dirname}/../config/config-default.json`);
