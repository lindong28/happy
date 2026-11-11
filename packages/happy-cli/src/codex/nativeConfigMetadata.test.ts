import { describe, expect, it } from 'vitest';
import { nativeConfigMetadata } from './nativeConfigMetadata';

describe('native configuration readout', () => {
    it('shows pending instead of Happy defaults until Codex responds', () => {
        const meta = nativeConfigMetadata();
        expect(meta.models?.[0].value).toBe('Waiting for Codex');
        expect(meta.thoughtLevels?.[0].value).toBe('Pending');
        expect(meta.operatingModes?.[0].description).toBe('Waiting for Codex');
    });

    it.each([
        { model: 'native-a', reasoningEffort: 'high', approvalPolicy: { granular: { mcp_elicitations: true } }, sandbox: { type: 'dangerFullAccess' } },
        { model: 'native-b', reasoningEffort: null, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } },
    ])('publishes the resolved response without substituting presets ($model)', config => {
        const meta = nativeConfigMetadata(config);
        expect(meta.currentModelCode).toBe(config.model);
        expect(meta.models?.[0].value).toBe(config.model);
        expect(meta.currentThoughtLevelCode).toBe(config.reasoningEffort ?? 'native-default');
        expect(meta.operatingModes?.[0].description).toContain(typeof config.approvalPolicy === 'string' ? config.approvalPolicy : JSON.stringify(config.approvalPolicy, null, 2));
        expect(meta.operatingModes?.[0].description).toContain(JSON.stringify(config.sandbox, null, 2));
        expect(meta.codexNativeConfig).toBe(true);
    });
});
