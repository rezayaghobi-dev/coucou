// OpenAI-compatible chat client — the "Custom" provider in settings.
//
// One base URL (e.g. https://router.example/v1) covers both the model list
// (GET /models) and the chat itself (POST /chat/completions). The API key stays
// in the keyring and never crosses into the webview.
//
// Deliberately narrower than the Anthropic path: no web search and no
// server-side fallback, because those are Anthropic's own request features and
// an OpenAI-compatible router will not understand them.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::claude::{
    base64_for, Chat, ChatContext, ChatReply, MAX_INLINE_TEXT, MAX_TOKENS, SYSTEM_PROMPT,
};
use crate::secrets;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// Human label when the endpoint provides one (many routers return a
    /// `name`); falls back to the id.
    pub name: String,
}

/// Joins a base URL and a path, tolerating a trailing slash on either side.
/// `https://host/v1` + `models` → `https://host/v1/models`.
fn endpoint(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim().trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Pulls the API's own message out of an error body, which is what makes a bad
/// key or an empty balance obvious instead of a bare status code.
fn describe_error(status: reqwest::StatusCode, text: &str) -> String {
    let detail = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.chars().take(200).collect());
    format!("API {status}: {detail}")
}

/// Models advertised by the endpoint, in the order the server returns them.
pub async fn list_models(base_url: &str, key: &str) -> Result<Vec<ModelInfo>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(endpoint(base_url, "models"))
        .bearer_auth(key)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(describe_error(status, &text));
    }

    let value: Value =
        serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "The endpoint returned no model list.".to_string())?;

    let mut models = Vec::with_capacity(data.len());
    for item in data {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let name = item.get("name").and_then(Value::as_str).unwrap_or(id);
        models.push(ModelInfo {
            id: id.to_string(),
            name: name.to_string(),
        });
    }
    Ok(models)
}

/// One chat turn against the custom endpoint, appending to the same `Chat` the
/// island already uses. The history format differs from Anthropic's, so
/// `begin_turn` clears it when the provider changed.
pub async fn send(
    chat: &Chat,
    base_url: &str,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    chat.begin_turn("custom");

    let key = secrets::get("custom-api-key")
        .ok_or_else(|| "API key missing. Open settings.".to_string())?;

    let mut parts: Vec<Value> = Vec::new();

    // File / window context rides along with the first message only.
    if chat.is_empty() {
        match &context {
            Some(ChatContext::File { name, path }) => {
                match attachment(path) {
                    Some(Attachment::Image(data_url)) => parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": data_url },
                    })),
                    Some(Attachment::Text(text)) => {
                        parts.push(json!({ "type": "text", "text": text }))
                    }
                    None => {}
                }
                parts.push(json!({ "type": "text", "text": format!("File: {name}") }));
            }
            Some(ChatContext::Window { app_name, title, url }) => {
                let mut text = format!("Context — App: {app_name}, Window: {title}");
                if let Some(url) = url {
                    text.push_str(&format!(", URL: {url}"));
                }
                parts.push(json!({ "type": "text", "text": text }));
            }
            None => {}
        }
    }
    parts.push(json!({ "type": "text", "text": query }));

    // A plain string is the shape every OpenAI-compatible server understands;
    // the content-parts array is only used when there is really an attachment.
    let content = if parts.len() == 1 {
        parts[0]
            .get("text")
            .cloned()
            .unwrap_or_else(|| Value::String(query.clone()))
    } else {
        Value::Array(parts)
    };

    chat.push(json!({ "role": "user", "content": content }));

    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    messages.extend(chat.snapshot());
    let body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": messages,
    });

    let response = match call(base_url, &key, &body).await {
        Ok(v) => v,
        Err(err) => {
            chat.pop(); // keep the history consistent with what the model saw
            return Err(err);
        }
    };

    let text = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        chat.pop();
        return Err("No response text.".into());
    }

    chat.push(json!({ "role": "assistant", "content": text }));
    Ok(ChatReply { text })
}

async fn call(base_url: &str, key: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .post(endpoint(base_url, "chat/completions"))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(describe_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("Bad API response: {e}"))
}

/// A dropped file, ready to ride along with the first message.
enum Attachment {
    /// Inline text or code.
    Text(String),
    /// A `data:` URL for an image.
    Image(String),
}

fn attachment(path: &str) -> Option<Attachment> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mime = match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };

    if let Some(mime) = mime {
        let bytes = std::fs::read(path).ok()?;
        return Some(Attachment::Image(format!(
            "data:{mime};base64,{}",
            base64_for(&bytes)
        )));
    }

    // PDFs are skipped: OpenAI's chat format has no document block. Anything
    // larger than the inline limit is skipped too, same as on Anthropic.
    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(Attachment::Text(format!("File contents:\n{text}")))
}

#[cfg(test)]
mod tests {
    use super::endpoint;

    #[test]
    fn endpoint_joins_without_doubling_or_dropping_slashes() {
        assert_eq!(endpoint("https://host/v1", "models"), "https://host/v1/models");
        assert_eq!(
            endpoint("https://host/v1/", "chat/completions"),
            "https://host/v1/chat/completions"
        );
        assert_eq!(endpoint("https://host/v1", "/models"), "https://host/v1/models");
    }
}
