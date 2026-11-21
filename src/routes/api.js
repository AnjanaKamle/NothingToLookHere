import { Router } from "express";
import * as auth from "../controllers/authController.js";
import * as requests from "../controllers/loginRequestController.js";
import * as sessions from "../controllers/sessionController.js";
import { authenticate, requirePhone } from "../middleware/authenticate.js";

const router = Router();

router.get("/health", (_req, res) => res.json({ ok: true }));
router.post("/auth/register", auth.register);
router.post("/auth/login", auth.login);
router.post("/auth/recover", auth.recover);
router.get("/auth/me", authenticate, auth.me);
router.post("/auth/logout", authenticate, auth.logout);
router.post("/requests", requests.createRequest);
router.get("/requests/preview/:token", authenticate, requirePhone, requests.previewRequest);
router.get("/requests/:id", requests.requestDetails);
router.post("/requests/approve", authenticate, requirePhone, requests.approveRequest);
router.get("/sessions", authenticate, requirePhone, sessions.listSessions);
router.delete("/sessions/:id", authenticate, requirePhone, sessions.revokeSession);

export default router;
