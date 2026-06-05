import {
  ActorQuerySourceIdentifyHypermediaVector,
  CliArgsHandlerVector,
  QuerySourceVector,
  VectorGrpcClient,
} from '../lib';

describe('index', () => {
  it('should export the package API', () => {
    expect(QuerySourceVector).toBeDefined();
    expect(ActorQuerySourceIdentifyHypermediaVector).toBeDefined();
    expect(CliArgsHandlerVector).toBeDefined();
    expect(VectorGrpcClient).toBeDefined();
  });
});
