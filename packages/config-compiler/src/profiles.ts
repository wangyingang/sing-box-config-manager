import type { Capability, ProfileId } from './types.js';

export const CAPABILITY_VERSION = 'd06-1';
// A deliberately small capability table, not a promise that every native feature works.
export const PROFILES: Record<ProfileId, Readonly<Record<Capability, boolean>>> = Object.freeze({
  'windows-standalone': Object.freeze({ processMatching: true, packageMatching: false, dhcpDns: true }),
  'macos-standalone': Object.freeze({ processMatching: true, packageMatching: false, dhcpDns: true }),
  'macos-appstore': Object.freeze({ processMatching: false, packageMatching: false, dhcpDns: true }),
  'ios-appstore': Object.freeze({ processMatching: false, packageMatching: false, dhcpDns: true }),
  'android-google-play': Object.freeze({ processMatching: false, packageMatching: true, dhcpDns: false }),
});
