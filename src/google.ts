import { google } from "googleapis";
import { config } from "./config.js";
import { saveGoogleAuth, updateGoogleAccessToken, getGoogleAuth, clearGoogleAuth } from "./db.js";

// userinfo.email is needed just so the dashboard can show which account got
// connected. drive.file = write access to files this app itself creates
// ("create a doc and share it"); drive.readonly = read/search the user's
// whole Drive ("cari di gdrive aku") without granting write access to it.
// Adding a scope requires the user to reconnect Google from the dashboard.
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export function isGoogleConfigured() {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

export function isGoogleConnected() {
  return isGoogleConfigured() && Boolean(getGoogleAuth());
}

function createOAuthClient() {
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
}

export function getAuthUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token
    prompt: "consent", // force re-issuing a refresh_token even on repeat connects
    scope: SCOPES,
  });
}

export async function handleOAuthCallback(code) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google didn't return a refresh_token (already authorized before without revoking?). " +
        "Revoke access at https://myaccount.google.com/permissions and try connecting again."
    );
  }
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const { data } = await oauth2.userinfo.get();

  saveGoogleAuth({
    email: data.email,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiryDate: tokens.expiry_date,
  });

  return data.email;
}

export function disconnectGoogle() {
  clearGoogleAuth();
}

/**
 * Returns an authenticated OAuth2 client (auto-refreshing) ready to pass
 * into google.calendar({ auth, version: "v3" }), or null if not connected.
 */
export function getAuthorizedClient() {
  const auth = getGoogleAuth();
  if (!auth) return null;

  const client = createOAuthClient();
  client.setCredentials({
    refresh_token: auth.refresh_token,
    access_token: auth.access_token,
    expiry_date: auth.expiry_date,
  });
  client.on("tokens", (tokens) => {
    if (tokens.access_token) updateGoogleAccessToken(tokens.access_token, tokens.expiry_date);
  });
  return client;
}
