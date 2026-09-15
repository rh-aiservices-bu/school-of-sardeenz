/// Extract the model name from an OpenAI API request body.
pub fn extract_model_name(body: &serde_json::Value) -> Option<String> {
    body.get("model").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Extract the model name from a V2 (OIP) inference/readiness URL path.
/// The model is the `{model}` path segment; axum's Path extractor already
/// isolates it, so this is a thin, testable normalizer/validator. Returns
/// None for an empty segment.
pub fn extract_model_name_from_path(model_segment: &str) -> Option<String> {
    let trimmed = model_segment.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_model_from_chat_completion() {
        let body = serde_json::json!({
            "model": "meta-llama/Llama-3.1-8B-Instruct",
            "messages": [{"role": "user", "content": "Hello"}]
        });
        assert_eq!(extract_model_name(&body), Some("meta-llama/Llama-3.1-8B-Instruct".to_string()));
    }

    #[test]
    fn returns_none_for_missing_model() {
        let body = serde_json::json!({"messages": []});
        assert_eq!(extract_model_name(&body), None);
    }

    #[test]
    fn extracts_simple_name() {
        assert_eq!(extract_model_name_from_path("iris-sklearn"), Some("iris-sklearn".to_string()));
    }

    #[test]
    fn returns_none_for_empty() {
        assert_eq!(extract_model_name_from_path(""), None);
    }
}
