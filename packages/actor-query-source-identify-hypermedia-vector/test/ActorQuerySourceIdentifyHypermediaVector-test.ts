import { KeysInitQuery } from '@comunica/context-entries';
import { ActionContext, Bus } from '@comunica/core';
import type * as RDF from '@rdfjs/types';
import { empty } from 'asynciterator';
import type { AsyncIterator } from 'asynciterator';
import { DataFactory } from 'rdf-data-factory';
import { ActorQuerySourceIdentifyHypermediaVector } from '../lib/ActorQuerySourceIdentifyHypermediaVector';
import '@comunica/utils-jest';

const DF = new DataFactory();

describe('ActorQuerySourceIdentifyHypermediaVector', () => {
  let bus: Bus<any, any, any, any>;
  let actor: ActorQuerySourceIdentifyHypermediaVector;
  const mediatorHttp: any = { mediate: jest.fn() };
  const mediatorMergeBindingsContext: any = { mediate: () => ({}) };

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
    actor = new ActorQuerySourceIdentifyHypermediaVector({
      bus,
      mediatorHttp,
      mediatorMergeBindingsContext,
      name: 'actor',
    });
  });

  const baseAction = {
    url: 'http://example.org/vector',
    metadata: {},
    quads: <RDF.Stream & AsyncIterator<RDF.Quad>> empty(),
    handledDatasets: {},
    context: new ActionContext(),
  };

  describe('testMetadata', () => {
    it('should pass for vector source type', async() => {
      await expect(actor.testMetadata({
        ...baseAction,
        forceSourceType: 'vector',
      })).resolves.toPassTest({ filterFactor: 1 });
    });

    it('should fail without vector source type', async() => {
      await expect(actor.testMetadata(baseAction))
        .resolves.toFailTest(`Actor ${actor.name} requires explicit source type 'vector'`);
    });
  });

  describe('run', () => {
    it('should return a QuerySourceVector', async() => {
      const context = new ActionContext({ [KeysInitQuery.dataFactory.name]: DF });
      const { source } = await actor.run({
        ...baseAction,
        context,
        forceSourceType: 'vector',
      });
      expect(source.referenceValue).toBe('http://example.org/vector');
      await expect(source.getFilterFactor(context)).resolves.toBe(1);
    });
  });
});
