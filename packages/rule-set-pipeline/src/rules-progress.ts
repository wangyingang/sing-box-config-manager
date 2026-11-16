export interface RulesProgress {
  stage: 'configuration' | 'state' | 'build' | 'candidate' | 'files' | 'metadata' | 'evidence'
    | 'prepare-delivery' | 'stable-write' | 'readback' | 'status' | 'cleanup';
  logicalId?: string;
}

export function reportRulesProgress(observer: ((event: RulesProgress) => void) | undefined, stage: RulesProgress['stage'], logicalId?: string) {
  // Observability must never turn a completed write into an apparent failure.
  try { Promise.resolve(observer?.({ stage, ...(logicalId && { logicalId }) })).catch(() => {}); }
  catch { /* A host's progress sink cannot change operation semantics. */ }
}

const labels: Record<RulesProgress['stage'], string> = {
  configuration: '读取正式配置', state: '核对远端状态', build: '读取来源并构建校验',
  candidate: '登记规则候选', files: '上传规则文件', metadata: '保存候选构建记录',
  evidence: '回读并验证候选', 'prepare-delivery': '验证候选并准备交付',
  'stable-write': '更新稳定订阅文件', readback: '回读确认交付', status: '核对当前版本与候选', cleanup: '检查与清理保留历史',
};

/** stderr only; stdout remains one final result for machine consumers. */
export function cliRulesProgress(output: (text: string) => void, now = Date.now) {
  const start = now();
  let current: RulesProgress = { stage: 'configuration' };
  const emit = () => {
    try { output(`[rules +${((now() - start) / 1000).toFixed(1)}s] ${current.logicalId ? `${current.logicalId}: ` : ''}${labels[current.stage]}`); }
    catch { /* A closed log stream must not interrupt delivery. */ }
  };
  const timer = setInterval(emit, 15_000); timer.unref();
  return { update(event: RulesProgress) { current = event; emit(); }, close() { clearInterval(timer); } };
}
