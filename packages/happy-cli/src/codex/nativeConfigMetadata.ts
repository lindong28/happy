import type { Metadata } from '@/api/types';

/** Only the resolved thread response is authoritative; never infer from Happy presets. */
export type NativeConfigReadout = {
    model: string;
    reasoningEffort: string | null;
    approvalPolicy: unknown;
    sandbox: unknown;
};

export function nativeConfigMetadata(config?: NativeConfigReadout): Pick<Metadata,
    'codexNativeConfig' | 'models' | 'currentModelCode' | 'operatingModes' | 'currentOperatingModeCode' | 'thoughtLevels' | 'currentThoughtLevelCode'> {
    const model = config?.model || 'native-config-pending';
    const effort = config ? config.reasoningEffort ?? 'native-default' : 'native-config-pending';
    const describe = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'Unknown';
    const permission = config
        ? `Approval: ${describe(config.approvalPolicy)}\nSandbox: ${describe(config.sandbox)}`
        : 'Waiting for Codex';
    return {
        codexNativeConfig: true,
        models: [{ code: model, value: config?.model || 'Waiting for Codex' }],
        currentModelCode: model,
        operatingModes: [{ code: 'native-config', value: 'Local settings', description: permission }],
        currentOperatingModeCode: 'native-config',
        thoughtLevels: [{ code: effort, value: config ? config.reasoningEffort ?? 'Codex default' : 'Pending' }],
        currentThoughtLevelCode: effort,
    };
}
