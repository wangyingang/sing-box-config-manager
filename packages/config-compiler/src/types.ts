export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: Json };
export type ProfileId = 'windows-standalone' | 'macos-appstore' | 'macos-standalone' | 'ios-appstore' | 'android-google-play';
export type Capability = 'processMatching' | 'packageMatching' | 'dhcpDns';
export interface Diagnostic { severity: 'error' | 'warning'; code: string; path: string; message: string; source?: { stepId: string; stepIndex: number; preset?: string; presetRuleIndex?: number; outputRuleIndex?: number; outputPath?: string } }
export type Result<T> = { ok: true; value: T; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };
export interface RuleArtifact {
  id: string; revision: string; sha256: string; url: string; format: 'source' | 'binary';
  requiredCapabilities: Capability[];
}
export type RuleSetBinding =
  | { kind: 'inline'; definition: Obj }
  | { kind: 'curated'; artifactId: string; tag: string; httpClient?: string };
export interface Resources {
  inbounds?: Obj[]; outbounds?: Obj[]; dnsServers?: Obj[]; httpClients?: Obj[];
  ruleSets?: RuleSetBinding[]; services?: Obj[];
}
export type Step = { preset: string } | { rule: Obj };
export interface Template {
  id: string; revision: string; targetVersion: '1.14.4';
  defaults: { log?: Obj; dns?: Obj; route?: Obj; experimental?: Obj; ntp?: Obj; certificate?: Obj };
  resources: Resources;
  platformDnsServers: Partial<Record<ProfileId, Obj[]>>;
  dnsPresets: Record<string, Obj[]>; routePresets: Record<string, Obj[]>;
  /** Only top-level evaluate rules with these tags may receive request-time ECS. */
  ecsResponseTags: string[];
}
export interface Recipe {
  id: string; revision: string; resources: Resources;
  settings?: { logLevel?: string; tunMtu?: number; dnsFinal?: string; routeFinal?: string };
  dnsSteps: Step[]; routeSteps: Step[];
}
export interface GenerationParams { ecs: { address: string; prefix: number } | null }
export interface CompileInput {
  template: Template; recipe: Recipe; artifacts: RuleArtifact[]; profile: ProfileId;
  params: GenerationParams;
}
export interface CompiledConfig {
  config: Obj;
  profile: ProfileId;
  ecsResponseTags: string[];
  artifacts: RuleArtifact[];
  versions: { target: '1.14.4'; compiler: string; capabilities: string; template: string; recipe: string; schema: string };
}
