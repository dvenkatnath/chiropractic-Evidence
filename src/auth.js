// Lightweight role + shared-passcode auth for a proof-of-concept demo.
// No user database — each of the 4 roles has one shared passcode, set via env vars
// (with defaults for local testing only; ALWAYS override these in Railway's env settings).

const ROLES = {
  clinic: {
    key: "clinic",
    label: "Clinic / Chiropractor",
    landing: "clinics",
    passcodeEnv: "PASSCODE_CLINIC",
    defaultPasscode: "cbp-clinic-2026",
  },
  researcher: {
    key: "researcher",
    label: "Researcher",
    landing: "evidence",
    passcodeEnv: "PASSCODE_RESEARCHER",
    defaultPasscode: "cbp-research-2026",
  },
  network_admin: {
    key: "network_admin",
    label: "Network Admin",
    landing: "overview",
    passcodeEnv: "PASSCODE_NETWORK_ADMIN",
    defaultPasscode: "cbp-network-2026",
  },
  executive: {
    key: "executive",
    label: "Executive & Policy",
    landing: "policy",
    passcodeEnv: "PASSCODE_EXECUTIVE",
    defaultPasscode: "cbp-policy-2026",
  },
};

function getPasscode(roleKey) {
  const role = ROLES[roleKey];
  if (!role) return null;
  return process.env[role.passcodeEnv] || role.defaultPasscode;
}

function verifyLogin(roleKey, passcode) {
  const role = ROLES[roleKey];
  if (!role) return false;
  const expected = getPasscode(roleKey);
  return typeof passcode === "string" && passcode.length > 0 && passcode === expected;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.role && ROLES[req.session.role]) {
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return res.redirect("/login.html");
}

module.exports = { ROLES, verifyLogin, requireAuth, getPasscode };
