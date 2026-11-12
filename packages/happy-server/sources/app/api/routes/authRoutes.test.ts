import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';
import { authRoutes } from './authRoutes';

const { upsert, createToken } = vi.hoisted(() => ({
    upsert: vi.fn(async () => ({ id: 'private-user' })),
    createToken: vi.fn(async () => 'test-token'),
}));
vi.mock('@/storage/db', () => ({ db: { account: { upsert } } }));
vi.mock('@/app/auth/auth', () => ({ auth: { createToken } }));
vi.mock('@/utils/log', () => ({ log: vi.fn() }));

const permitted = nacl.sign.keyPair();
const stranger = nacl.sign.keyPair();
const hex = (key: Uint8Array) => Buffer.from(key).toString('hex');
const b64 = (key: Uint8Array) => Buffer.from(key).toString('base64');

function makeApp() {
    const app = fastify().withTypeProvider<ZodTypeProvider>() as Fastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async () => {});
    authRoutes(app);
    return app;
}

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('private server account admission', () => {
    it.each([undefined, hex(permitted.publicKey), ` ${hex(permitted.publicKey).toUpperCase()} , ${hex(stranger.publicKey)}`])('accepts a signed admitted account (%s)', async setting => {
        vi.stubEnv('HAPPY_ALLOWED_PUBLIC_KEYS', setting);
        const app = makeApp();
        try {
            const challenge = nacl.randomBytes(32);
            const response = await app.inject({ method: 'POST', url: '/v1/auth', payload: {
                publicKey: b64(permitted.publicKey), challenge: b64(challenge),
                signature: b64(nacl.sign.detached(challenge, permitted.secretKey)),
            } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ success: true, token: 'test-token' });
            expect(upsert).toHaveBeenCalledOnce();
        } finally { await app.close(); }
    });

    it.each([false, true])('rejects an unlisted or forged identity before storing/minting (forged=%s)', async forged => {
        vi.stubEnv('HAPPY_ALLOWED_PUBLIC_KEYS', hex(permitted.publicKey));
        const app = makeApp();
        try {
            const challenge = nacl.randomBytes(32);
            const response = await app.inject({ method: 'POST', url: '/v1/auth', payload: {
                publicKey: b64(forged ? permitted.publicKey : stranger.publicKey), challenge: b64(challenge),
                signature: b64(nacl.sign.detached(challenge, stranger.secretKey)),
            } });
            expect(response.statusCode).toBe(forged ? 401 : 403);
            expect(upsert).not.toHaveBeenCalled();
            expect(createToken).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it.each(['', ' ', 'not-a-key', `${hex(permitted.publicKey)},`])('rejects an explicit invalid setting (%s)', setting => {
        vi.stubEnv('HAPPY_ALLOWED_PUBLIC_KEYS', setting);
        expect(makeApp).toThrow('HAPPY_ALLOWED_PUBLIC_KEYS');
    });
});
