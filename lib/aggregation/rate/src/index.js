'use strict';

// Usage rating service

const _ = require('underscore');
const yieldable = require('abacus-yieldable');
const transform = require('abacus-transform');
const batch = require('abacus-batch');
const retry = require('abacus-retry');
const breaker = require('abacus-breaker');
const dbclient = require('abacus-dbclient');
const urienv = require('abacus-urienv');
const webapp = require('abacus-webapp');
const cluster = require('abacus-cluster');
const router = require('abacus-router');
const request = require('abacus-request');
const seqid = require('abacus-seqid');
const lockcb = require('abacus-lock');
const config = require('abacus-resource-config');
const prices = require('abacus-price-config');
const db = require('abacus-aggregation-db');

const filter = _.filter;
const map = _.map;
const zip = _.zip;
const flatten = _.flatten;
const last = _.last;
const clone = _.clone;
const extend = _.extend;
const omit = _.omit;
const values = _.values;
const sortBy = _.sortBy;
const groupBy = _.groupBy;

const get = yieldable(retry(breaker(request.get)));

const lock = yieldable(lockcb);

// Setup debug log
const debug = require('abacus-debug')('abacus-usage-rate');

// Resolve service URIs
const uris = urienv({
  couchdb: 5984,
  account: 9381
});

// Configure rated usage db
const ratedb = yieldable(
  batch(retry(breaker(db(uris.couchdb, 'abacus-rated-usage')))));
const logdb = yieldable(
  batch(retry(breaker(db(uris.couchdb, 'abacus-rated-usage-log')))));

// Configure the rated usage cache
const ratecache = yieldable(db.cache('abacus-rated-usage'));

// Return a doc location given a route template and params
const loc = (req, template, params) => req.protocol + '://' +
  req.headers.host + request.route(template, params);

// Return the rating start time for a given time
const day = (t) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// Return the pricing country configured for an organization's account
const pricingCountry = function *(oid) {
  const account = yield get(uris.account + '/v1/orgs/:org_id/account', {
    org_id: oid
  });

  // Default to USA
  return !account.body || !account.body.pricing_country ?
    'USA' : account.body.pricing_country;
};

// Return the configured price for the given resource, plan, metric, and
// country
const price = (rid, pid, metric, country) => {
  // Retrieve the resource price config
  const resource = prices(rid);
  if(resource) {
    // Find the specified plan
    const plan = filter(resource.plans, (p) => p.plan_id === pid);
    if(plan.length) {
      // Find the specified metric price
      const metrics = filter(plan[0].metrics, (m) => m.name === metric);

      // Use the configured price for the specified country, default to 0
      const prices = filter(metrics[0].prices, (p) => p.country === country);
      return prices.length ? prices[0].price : 0;
    }
  }
  return 0;
};

// Return the rate function for a given metric
const ratefn = (metrics, metric) => {
  return filter(metrics, (m) => m.name === metric)[0].ratefn;
};

// Rates the given aggregated usage
const rate = (r, u, pc) => {
  // Rate the aggregated usage under a resource
  const rateResource = (rs) => {

    // Find the metrics configured for the given resource
    const metrics = config(rs.resource_id).metrics;

    // Compute the cost of each metric under the resource plans
    return extend(clone(rs), {

      plans: map(rs.plans, (p) => {
        return extend(clone(p), {
          aggregated_usage: map(p.aggregated_usage, (m) => {

            // Find the rate function configured for each metric
            const rfn = ratefn(metrics, m.metric);

            // Clone the metric and return it along with the calculated cost
            return extend(clone(m), {
              cost: rfn(price(
                rs.resource_id, p.plan_id, m.metric, pc), m.quantity)
            });
          })
        });
      })
    });
  };

  // Clone the aggregated usage and extend if with the computed costs
  const newr = extend(clone(r), {
    resources: map(u.resources, rateResource),
    spaces: map(u.spaces, (space) => {
      return extend(clone(space), {
        resources: map(space.resources, rateResource),
        consumers: map(space.consumers, (consumer) => {
          return extend(clone(consumer), {
            resources: map(consumer.resources, rateResource)
          });
        })
      });
    })
  });

  // Use db and cache revisions from last rated usage
  if(r)
    extend(newr,
      r.dbrev ? { dbrev: r.dbrev, _rev: r._rev } : { _rev: r._rev });
  debug('New rated usage %o', newr);
  return newr;
};

// Retrieved the rated usage
const ratedUsage = function *(id) {
  debug('Retrieving rated usage for %s', id);
  const doc = (yield ratecache.get(id)) || (yield ratedb.get(id));
  if(doc)
    debug('Found rated usage %o in %s', doc, doc.dbrev ? 'cache' : 'db');
  else
    debug('No existing rated usage');
  return doc;
};

// Log the rated usage
const logRatedUsage = function *(rlogdoc, rlogid) {
  debug('Logging rated usage %s', rlogid);
  yield logdb.put(extend(clone(rlogdoc), { _id: rlogid }));
  debug('Logged rated usage %o', rlogdoc);
  return rlogdoc;
};


// Store the rated usage
const storeRatedUsage = function *(r, rid, rlogid, uid) {
  debug('Updating rated usage %s', rid);
  const rdoc = extend(clone(omit(r, 'dbrev')), {
    id: rid, last_rated_usage_id: rlogid, aggregated_usage_id: uid });
  const rrev = yield ratedb.put(extend(clone(rdoc), {
    _id: rid }, r.dbrev ? { _rev: r.dbrev } : {}));
  yield ratecache.put(extend(clone(rdoc), { _id: rid, dbrev: rrev.rev }));
  debug('Updated rated usage %o', rdoc);
  return rid;
};

// Get rated usage, update and store it
const updateRatedUsage = function *(rid, udocs) {
  debug('Update rated usage for a group of %d usage docs', udocs.length);
  // Lock based on the given org and time period
  const unlock = yield lock(rid);
  try {
    // Retrieve the old rated usage for the given org and time
    const r = yield ratedUsage(rid);

    // Initialize the new rated usage
    // Remove last_rated_usage_id to avoid writing this property to
    // rated usage log
    let newr = r ? omit(r, 'last_rated_usage_id') :
      { organization_id: udocs[0].u.organization_id, start: udocs[0].u.start,
        end: udocs[0].u.end };

    // Retrieve the pricing country configured for the org's account
    const pc =
      yield pricingCountry(udocs[0].u.organization_id);

    // Rate the usage docs
    const rdocs = map(udocs, (udoc) => {
      newr = rate(newr, udoc.u, pc);
      return newr;
    });

    // Store the final new rated usage
    const ludoc = last(udocs);
    yield storeRatedUsage(newr, rid, ludoc.rlogid, ludoc.uid);

    return rdocs;
  }
  finally {
    unlock();
  }
};

// Rate usage by batching individual calls and then
// by grouping them using the given org and time period
const batchRateUsage = yieldable(batch((b, cb) => {
  // Map individual rated usage into a batch response array and
  // then call the callback
  const bcb = (err, rdocs) => err ?
    cb(err) : cb(null, map(rdocs, (rdoc) => [null, rdoc]));

  transform.map(b, (args, i, b, mcb) => {
    // Map individual call arguments into a call object
    mcb(null, { i: i, rid: args[1],
      udoc: { u: args[0], rlogid: args[2], uid: args[3] } });
  }, (err, objs) => {
    if (err) return cb(err);

    // Group the transformed call objects using the given org and time period
    const groups = values(groupBy(objs, (obj) => obj.rid));

    // Call updateRatedUsage for each group
    transform.map(groups, (group, i, groups, mcb) => {
      yieldable.functioncb(updateRatedUsage)(group[0].rid,
        map(group, (obj) => obj.udoc), (err, rdocs) => {
          // Zip grouped call objects with corresponding rated usage
          return mcb(null, zip(group,
            err ? map(group, (obj) => ({ error: err })) : rdocs));
        });
    }, (err, objs) => {
      if (err) return bcb(err);

      // Order the zipped call objects using the original call index of
      // the batch and then return the ordered rated usage
      bcb(null, map(sortBy(flatten(objs, true), (obj) => obj[0].i),
        (obj) => obj[1]));
    });
  });
}));


// Rate the given aggregated usage
const rateUsage = function *(u) {
  // Compute the rated usage id and the rated usage log id
  const rid = dbclient.kturi(u.organization_id, day(u.end));
  const rlogid = dbclient.kturi(u.organization_id, [
    day(u.end), seqid()].join('/'));

  // Rate the usage
  const newr = yield batchRateUsage(u, rid, rlogid, u.id);

  // Log the rated usage
  const rlogdoc = extend(clone(newr), {
    id: rlogid, aggregated_usage_id: u.id });
  yield logRatedUsage(rlogdoc, rlogid);

  return rlogid;
};

// Create an express router
const routes = router();

// Rate a given aggregated usage
routes.post('/v1/rating/usage', function *(req) {
  debug('Received usage to be rated %o', req.body);

  // Validate the input
  if(!req.body) return {
      statusCode: 400
    };
  const u = req.body;

  // Rate the usage
  const id = yield rateUsage(u);

  return {
    statusCode: 201,
    header: {
      Location: loc(req, '/v1/rating/rated/usage/:id', {
        id: id
      })
    }
  };
});

// Retrieve the rated usage associated with the given id
routes.get(
  '/v1/rating/rated/usage/k/:organization_id/t/:day/:seq', function *(req) {
    const id = dbclient.kturi(req.params.organization_id,
      [req.params.day, req.params.seq].join('/'));
    debug('Retrieving rated usage for id %s', id);

    // Retrieve and return the metered usage doc, and clone it without _id and
    // _rev properties
    const doc = omit(yield logdb.get(id),
      ['_id', '_rev', 'last_rated_usage_id']);

    // return the doc as response body
    return {
      body: doc
    };
  });

// Perform recovery logic when the application starts
const recover = () => {
  // Process any unprocessed docs from our input db

  // TODO insert our recovery logic here
};

// Create a rate app
const rateapp = () => {
  // Configure Node cluster to use a single process as we want to serialize
  // rating requests per db partition and app instance
  cluster.singleton();

  // Perform recovery if necessary
  recover();

  // Create the Webapp
  const app = webapp();
  app.use(routes);
  app.use(router.batch(routes));
  return app;
};

// Command line interface, create the rate app and listen
const runCLI = () => rateapp().listen();

// Export public methods
module.exports = rateapp;
module.exports.rate = rate;
module.exports.runCLI = runCLI;
