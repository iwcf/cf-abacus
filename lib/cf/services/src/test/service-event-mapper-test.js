'use strict';

const moment = require('abacus-moment');
const yieldable = require('abacus-yieldable');

const states = require('../service-event-states');

const createEventMapper = require('../service-event-mapper');

describe('service event mapper tests', () => {
  let event;
  let mapper;
  let sandbox;
  let mappedEvents;
  let precedingUsagesReaderFake;

  const eventTime = '2017-12-27T12:13:14Z';
  
  const usageEvent = () => {
    const defaultValue = 'default-value';

    let planName = defaultValue;
    let eventState = defaultValue;
    let createdAt = eventTime;

    const overwritable = {
      state: (val) => {
        eventState = val;
        return overwritable;
      },
      createdAt: (val) => {
        createdAt = val;
        return overwritable;
      },
      planName: (val) => {
        planName = val;
        return overwritable;
      },
      get: () => ({
        metadata: {
          created_at: createdAt,
          guid: defaultValue
        },
        entity: {
          org_guid: defaultValue,
          state: eventState,
          space_guid: defaultValue,
          service_plan_name: planName,
          service_label: defaultValue,
          service_instance_guid: defaultValue
        }
      })
    };

    return overwritable;
  };

  beforeEach(() => {
    sandbox = sinon.sandbox.create();
    precedingUsagesReaderFake = {
      getPrecedingCreatedUsagePlanName: sandbox.stub()
    };
    mapper = createEventMapper(precedingUsagesReaderFake);
  });

  afterEach(() => {
    sandbox.restore();
  });

  context('when supported event is provided', () => {
    context('CREATED event', () => {
      beforeEach(yieldable.functioncb(function*() {
        event = usageEvent()
          .state(states.CREATED)
          .createdAt(eventTime)
          .get();
        mappedEvents = yield mapper.toMultipleEvents(event);
      }));
      
      it('should map to array of single CREATED event', () => {
        expect(mappedEvents).to.deep.equal([event]);
      });
    });
  
    context('DELETED event', () => {
      beforeEach(yieldable.functioncb(function*() {
        event = usageEvent()
          .state(states.DELETED)
          .createdAt(eventTime)
          .get();
        mappedEvents = yield mapper.toMultipleEvents(event);
      }));
      
      it('should map to array of single DELETED event', () => {
        expect(mappedEvents).to.deep.equal([event]);
      });
    });

    context('UPDATED event', () => {
      const getCalledWithParameter = (event) => ({
        serviceInstanceGuid: event.entity.service_instance_guid,
        orgGuid: event.entity.org_guid,
        spaceGuid: event.entity.space_guid
      });

      beforeEach(() => {
        event = usageEvent()
          .state(states.UPDATED)
          .get();
      });

      context('when precedin usage event plan name is not found', () => {
        beforeEach(yieldable.functioncb(function*() {
          precedingUsagesReaderFake.getPrecedingCreatedUsagePlanName.callsFake(function*() { 
            return undefined; 
          });
          mappedEvents = yield mapper.toMultipleEvents(event);
        }));
        
        it('should return expected business error', () => {
          const expectedError = { businessError: 'No preceding usage event found!'};
          expect(mappedEvents).to.deep.equal(expectedError);
          assert.calledWith(precedingUsagesReaderFake.getPrecedingCreatedUsagePlanName, getCalledWithParameter(event));
        });
      });

      context('when preceding usage event plan name is found', () => {
        const precedingPlanName = 'precedingPlanName';

        beforeEach(yieldable.functioncb(function*() {
          precedingUsagesReaderFake.getPrecedingCreatedUsagePlanName.callsFake(function*() { 
            return precedingPlanName; 
          });
          mappedEvents = yield mapper.toMultipleEvents(event);
        }));

        it('should map to array of two valid events', () => {
          const expectedEvents = [];
          expectedEvents.push(usageEvent()
            .state(states.DELETED)
            .planName(precedingPlanName)
            .createdAt(moment.utc(eventTime).valueOf())
            .get()
          );
          expectedEvents.push(usageEvent()
            .state(states.CREATED)
            .createdAt(moment.utc(eventTime).add(1, 'millisecond').valueOf())
            .get()
          );  

          expect(mappedEvents).to.deep.equal(expectedEvents);
          assert.calledWith(precedingUsagesReaderFake.getPrecedingCreatedUsagePlanName, getCalledWithParameter(event));
        });
      });
    });
  });

  context('when unsupported event is provided', () => {

    beforeEach(yieldable.functioncb(function*() {
      event = usageEvent()
        .state('UNSUPPORTED')
        .get();
      mappedEvents = yield mapper.toMultipleEvents(event);
    }));

    it('should return expected business error', () => {
      const expectedError = { businessError: `Event has invalid state: ${event.entity.state}`};
      expect(mappedEvents).to.deep.equal(expectedError);
    });
  });
});