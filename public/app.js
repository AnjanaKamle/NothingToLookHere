const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const approvalToken = params.get("approve");
// Phones sign in with a password; laptops and desktops only ever see the QR code.
const isPhone = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
let currentMode = "login";
let pollTimer;
let signedInTimer;

function show(...ids) {
  for (const id of ["browser-panel", "auth-panel", "approval-panel", "phone-panel"])
    $(id).classList.add("hidden");
  for (const id of ids) $(id).classList.remove("hidden");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status; // lets callers tell "signed out" (401) apart from network trouble
    throw error;
  }
  return data;
}

async function refreshSessions() {
  const { sessions } = await api("/api/sessions");
  const list = $("session-list");
  list.replaceChildren();
  if (!sessions.length) list.innerHTML = "<li class=muted>No active browser sessions.</li>";
  for (const session of sessions) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${session.name} · signed in ${new Date(session.createdAt).toLocaleString()}`;
    const button = document.createElement("button");
    button.textContent = "Sign out";
    button.className = "small-button";
    button.addEventListener("click", async () => {
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      await refreshSessions();
    });
    item.append(label, button);
    list.append(item);
  }
}

async function showPhone(user) {
  $("title").textContent = "Your phone is signed in";
  $("intro").textContent =
    "Scan a computer's QR code to approve its sign-in, or manage active browsers here.";
  $("phone-user").textContent = `Signed in as ${user.phone}`;
  if (approvalToken) {
    show("approval-panel");
    $("browser-name").textContent = "Loading browser details…";
    $("title").textContent = "Approve this sign-in?";
    $("intro").textContent = "Only approve if you just scanned this QR code yourself.";
    try {
      const preview = await api(`/api/requests/preview/${encodeURIComponent(approvalToken)}`);
      $("browser-name").textContent = preview.browserName;
    } catch (error) {
      $("approval-message").textContent = error.message;
    }
  } else {
    show("phone-panel");
    await refreshSessions();
  }
}

function showAuth() {
  $("title").textContent = approvalToken ? "Sign in to approve" : "Sign in on your phone";
  $("intro").textContent = approvalToken
    ? "Sign in with the account that should approve this browser."
    : "Use your phone number and password.";
  show("auth-panel");
}

$("show-login").addEventListener("click", () => setAuthMode("login"));
$("show-register").addEventListener("click", () => setAuthMode("register"));
function setAuthMode(mode) {
  currentMode = mode;
  $("show-login").classList.toggle("active", mode === "login");
  $("show-register").classList.toggle("active", mode === "register");
  $("device-label").classList.toggle("hidden", mode !== "register");
  $("auth-submit").textContent = mode === "register" ? "Create account" : "Sign in";
  $("password").autocomplete = mode === "register" ? "new-password" : "current-password";
}

$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("auth-message").textContent = "";
  try {
    const data = await api(`/api/auth/${currentMode}`, {
      method: "POST",
      body: JSON.stringify({
        phone: $("phone").value,
        password: $("password").value,
        deviceName: $("device-name").value
      })
    });
    await showPhone(data.user);
  } catch (error) {
    $("auth-message").textContent = error.message;
  }
});

$("approve").addEventListener("click", () => decide("approve"));
$("deny").addEventListener("click", () => decide("deny"));
async function decide(decision) {
  try {
    await api("/api/requests/approve", {
      method: "POST",
      body: JSON.stringify({ token: approvalToken, decision })
    });
    $("approval-message").textContent =
      decision === "approve" ? "Approved. Return to the computer." : "Request denied.";
    $("approve").disabled = true;
    $("deny").disabled = true;
  } catch (error) {
    $("approval-message").textContent = error.message;
  }
}

$("create-request").addEventListener("click", async () => {
  try {
    $("global-message").textContent = "";
    const request = await api("/api/requests", { method: "POST" });
    $("qr").src = request.qr;
    $("qr-area").classList.remove("hidden");
    $("request-message").textContent =
      "Scan this code with your phone camera. It expires in two minutes.";
    clearInterval(pollTimer);
    pollTimer = setInterval(() => pollRequest(request.id), 2000);
  } catch (error) {
    $("global-message").textContent = error.message;
  }
});

async function pollRequest(id) {
  try {
    const result = await api(`/api/requests/${id}`);
    if (result.status === "APPROVED") {
      clearInterval(pollTimer);
      showSignedInComputer();
    }
    if (["DENIED", "EXPIRED"].includes(result.status)) {
      clearInterval(pollTimer);
      $("request-message").textContent =
        result.status === "DENIED"
          ? "The request was denied."
          : "The QR request expired. Create another one.";
    }
  } catch (error) {
    clearInterval(pollTimer);
    $("request-message").textContent = error.message;
  }
}

// The computer, once signed in, checks every 3 seconds that its session still exists.
// When the phone signs it out, the next check gets a 401 and the page goes back to the QR screen.
function showSignedInComputer() {
  show("browser-panel");
  $("title").textContent = "This browser is signed in";
  $("intro").textContent = "You can now use this browser. Sign out when you are finished.";
  $("create-request").classList.add("hidden");
  $("qr-area").classList.add("hidden");
  $("browser-user").classList.remove("hidden");
  $("browser-logout").classList.remove("hidden");
  clearInterval(signedInTimer);
  signedInTimer = setInterval(checkStillSignedIn, 3000);
}

async function checkStillSignedIn() {
  try {
    await api("/api/auth/me");
  } catch (error) {
    if (error.status !== 401) return; // a network hiccup: try again on the next tick
    clearInterval(signedInTimer);
    showComputerStart("This browser was signed out from your phone.");
  }
}

function showComputerStart(message = "") {
  $("title").textContent = "Sign in on this computer";
  $("intro").textContent = "Use your signed-in phone to approve a one-time QR request.";
  $("create-request").classList.remove("hidden");
  $("qr-area").classList.add("hidden");
  $("browser-user").classList.add("hidden");
  $("browser-logout").classList.add("hidden");
  $("global-message").textContent = message;
  show("browser-panel");
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/";
}
$("phone-logout").addEventListener("click", logout);
$("browser-logout").addEventListener("click", logout);

async function start() {
  if (approvalToken) {
    try {
      const { user, type } = await api("/api/auth/me");
      if (type === "PHONE") await showPhone(user);
      else showAuth();
    } catch {
      showAuth();
    }
    return;
  }
  try {
    const { user, type } = await api("/api/auth/me");
    if (type === "PHONE") return showPhone(user);
    if (type === "BROWSER") return showSignedInComputer();
  } catch {
    /* Not signed in yet. */
  }
  if (isPhone) return showAuth();
  showComputerStart();
}

start();
