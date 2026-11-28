// netlify/functions/subscribe.js
//
// Securely adds/updates a contact in Mailchimp when someone completes the
// "Which False Identity Is Driving Your Burnout?" assessment at /assessment/.
//
// This function is the ONLY place that talks to Mailchimp. The Mailchimp API
// key never appears in front-end code — it is read here from environment
// variables that are set in the Netlify dashboard (Site settings > Environment
// variables), not committed to the repo.
//
// Required environment variables (set these in Netlify):
//   MAILCHIMP_API_KEY        - your Mailchimp API key
//   MAILCHIMP_SERVER_PREFIX  - the datacenter prefix from the end of your API
//                               key, e.g. if your key ends in "-us21" this is "us21"
//   MAILCHIMP_AUDIENCE_ID    - the Audience/List ID you want new subscribers
//                               added to
//
// See the bottom of this file for exactly where to find each value in
// Mailchimp.

const crypto = require("crypto");

const IDENTITY_TAGS = ["Failure", "Imposter", "Rejected One", "Unworthy", "Performer"];

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return respond(405, { success: false, error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return respond(400, { success: false, error: "Invalid JSON body" });
  }

  const firstName = (payload.firstName || "").toString().trim();
  const email = (payload.email || "").toString().trim();
  const identity = (payload.identity || "").toString().trim();

  if (!firstName || !email) {
    return respond(400, { success: false, error: "firstName and email are required" });
  }
  if (!isValidEmail(email)) {
    return respond(400, { success: false, error: "A valid email address is required" });
  }

  const apiKey = process.env.MAILCHIMP_API_KEY;
  const serverPrefix = process.env.MAILCHIMP_SERVER_PREFIX;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!apiKey || !serverPrefix || !audienceId) {
    // Misconfiguration on our end — never block the visitor from seeing
    // their results because of this, just report it so it shows up in logs.
    console.error("Missing Mailchimp environment variables.");
    return respond(500, { success: false, error: "Mailchimp is not configured" });
  }

  const tag = IDENTITY_TAGS.includes(identity) ? identity : null;

  const subscriberHash = crypto
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");

  const baseUrl = `https://${serverPrefix}.api.mailchimp.com/3.0`;
  const memberUrl = `${baseUrl}/lists/${audienceId}/members/${subscriberHash}`;
  const authHeader = "Basic " + Buffer.from(`anystring:${apiKey}`).toString("base64");

  try {
    // Upsert the contact (PUT creates-or-updates by subscriber hash).
    const memberResponse = await fetch(memberUrl, {
      method: "PUT",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        status_if_new: "subscribed",
        merge_fields: {
          FNAME: firstName,
        },
      }),
    });

    const memberData = await memberResponse.json();

    // Mailchimp returns 400 with title "Member Exists" in some edge cases,
    // and otherwise already-subscribed contacts simply succeed via PUT above.
    // Treat both "already subscribed" shapes as success, not an error.
    const alreadySubscribed =
      memberData &&
      ((memberData.status === "subscribed") ||
        (memberData.title && memberData.title === "Member Exists"));

    if (!memberResponse.ok && !alreadySubscribed) {
      console.error("Mailchimp member upsert failed:", memberData);
      return respond(502, { success: false, error: "Mailchimp request failed" });
    }

    // Tag the contact with their identity result, if we have a valid one.
    if (tag) {
      const tagResponse = await fetch(`${memberUrl}/tags`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tags: [{ name: tag, status: "active" }],
        }),
      });

      if (!tagResponse.ok) {
        // Don't fail the whole request over a tagging issue — the contact
        // is already saved, which is what matters most.
        const tagData = await tagResponse.json().catch(() => ({}));
        console.error("Mailchimp tagging failed:", tagData);
      }
    }

    return respond(200, { success: true });
  } catch (err) {
    console.error("Mailchimp request error:", err);
    return respond(502, { success: false, error: "Could not reach Mailchimp" });
  }
};

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function respond(statusCode, bodyObj) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}

/*
WHERE TO FIND EACH ENVIRONMENT VARIABLE VALUE IN MAILCHIMP
============================================================

1. MAILCHIMP_API_KEY
   Mailchimp account > Profile icon (bottom left) > Profile > Extras >
   API keys. Create a new key if you don't have one. It will look like:
   abc123def456abc123def456abc123d-us21

2. MAILCHIMP_SERVER_PREFIX
   This is the part of the API key AFTER the final dash.
   For the example key above, it's: us21

3. MAILCHIMP_AUDIENCE_ID
   Mailchimp account > Audience > Audience dashboard > Settings >
   Audience name and defaults. Look for "Audience ID" — it looks like:
   a1b2c3d4e5

Add all three in Netlify at:
   Site configuration > Environment variables > Add a variable
(one entry per variable, available to all deploy contexts).

After adding them, trigger a new deploy (or redeploy) so the function
picks them up.
*/
