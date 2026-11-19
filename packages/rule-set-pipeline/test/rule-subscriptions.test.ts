import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredSubscriptions, parseBuildConfiguration, readOfficialConfiguration } from '../src/configuration.js';

test('official configuration provides stable subscriptions and reuses files across compatible usages', () => {
  for (const branch of ['main', 'acceptance-subscriptions']) {
    const official = parseBuildConfiguration(readOfficialConfiguration());
    const configuration = parseBuildConfiguration(JSON.stringify({ ...official, target: { ...official.target, branch } }));
    const subscriptions = configuredSubscriptions(configuration);
    assert.deepEqual(Object.keys(subscriptions), ['openai', 'anthropic', 'google-deepmind', 'china-ip', 'chatgpt-voice',
      'china-domains', 'global', 'apple', 'microsoft', 'docker', 'github', 'google', 'youtube']);
    for (const [id, subscription] of Object.entries(subscriptions)) {
      assert.equal(subscription.systemRuleSetId, id);
      const route = subscription.projections.route;
      const prefix = `https://raw.githubusercontent.com/wangyingang/sing-box-rule-artifacts/${branch}/stable/${id}`;
      const ip = id === 'china-ip' || id === 'chatgpt-voice';
      const stem = ip ? 'route' : 'domains';
      assert.deepEqual(route, { formats: {
        binary: { url: `${prefix}/${stem}.srs`, requiredCapabilities: [] },
        source: { url: `${prefix}/${stem}.json`, requiredCapabilities: [] },
      } });
      assert.deepEqual(subscription.projections[ip ? 'dns-response' : 'dns-query'], route);
      assert.deepEqual(subscription.projections[ip ? 'dns-query' : 'dns-response'], { unavailable: 'empty' });
    }
  }
});
