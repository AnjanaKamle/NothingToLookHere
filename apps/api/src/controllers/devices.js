import { z } from 'zod';
import { fields, parseInput } from '../http/validate.js';
import { requestContext } from '../http/auth.js';
import { enrollDevice, issueEnrollmentChallenge, rotateDeviceKey } from '../services/enrollment.js';
import { listActivity, listDevices, revokeDevice } from '../services/devices.js';

const proofFields = {
  enrollmentId: fields.uuid,
  nonce: fields.nonce,
  // 91-byte SPKI = 122 base64url chars; DER signature <= 72 bytes = 96 chars.
  publicKey: fields.base64url(200),
  signature: fields.base64url(100),
  keyStorage: z.enum(['secure_enclave', 'strongbox', 'tee', 'software', 'unknown']),
};

const enrollSchema = z.strictObject({
  ...proofFields,
  deviceName: z.string().trim().min(1).max(64),
  platform: z.enum(['ios', 'android']),
});

const rotateSchema = z.strictObject(proofFields);
const revokeSchema = z.strictObject({ reason: z.enum(['user', 'lost']).default('user') });
const deviceParams = z.strictObject({ deviceId: fields.uuid });
const activityQuery = z
  .strictObject({
    before: z.iso.datetime({ offset: true }).optional(),
    beforeId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => (q.before === undefined) === (q.beforeId === undefined), {
    message: 'before and beforeId must be given together',
    path: ['before'],
  });

export function createDeviceController({ pool, config, notifier }) {
  return {
    /** POST /api/devices/enroll */
    async enroll(req, res) {
      const input = parseInput(enrollSchema, req.body);
      res.status(201).json(await enrollDevice(pool, config, input, requestContext(req)));
    },

    /** GET /api/devices */
    async list(req, res) {
      res.json({ devices: await listDevices(pool, req.device) });
    },

    /** POST /api/devices/:deviceId/revoke */
    async revoke(req, res) {
      const { deviceId } = parseInput(deviceParams, req.params);
      const { reason } = parseInput(revokeSchema, req.body);
      const result = await revokeDevice(
        pool,
        notifier,
        req.device,
        deviceId,
        reason,
        requestContext(req),
      );
      res.json(result);
    },

    /** POST /api/devices/me/key-rotation: fresh proof-of-possession challenge for a new key. */
    async startKeyRotation(req, res) {
      res.json({ enrollment: await issueEnrollmentChallenge(pool, config, req.device.userId) });
    },

    /** POST /api/devices/me/keys */
    async rotateKey(req, res) {
      const input = parseInput(rotateSchema, req.body);
      res
        .status(201)
        .json(await rotateDeviceKey(pool, config, req.device, input, requestContext(req)));
    },

    /** GET /api/activity */
    async activity(req, res) {
      const query = parseInput(activityQuery, req.query);
      res.json(await listActivity(pool, req.device, query));
    },
  };
}
