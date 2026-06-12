/// Extract the model name from an OpenAI API request body.
pub fn extract_model_name(body: &serde_json::Value) -> Option<String> {
    body.get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
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
        assert_eq!(
            extract_model_name(&body),
            Some("meta-llama/Llama-3.1-8B-Instruct".to_string())
        );
    }

    #[test]
    fn returns_none_for_missing_model() {
        let body = serde_json::json!({"messages": []});
        assert_eq!(extract_model_name(&body), None);
    }
}
