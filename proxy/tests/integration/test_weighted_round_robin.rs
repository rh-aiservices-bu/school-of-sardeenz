// test_weighted_round_robin: multiple endpoints get traffic proportional to
// their configured weights.

use reqwest::StatusCode;

use crate::common::{MockRunner, TestProxy, insert_active_model_multi};

#[tokio::test]
async fn test_weighted_round_robin() {
    let model = "meta-llama/Llama-3.1-8B-Instruct";

    // Two runners: heavy (weight 3) and light (weight 1).
    let heavy = MockRunner::spawn(model).await;
    let light = MockRunner::spawn(model).await;

    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;

    // Register both endpoints with their respective weights.
    insert_active_model_multi(
        &proxy.routing_cache,
        model,
        vec![(heavy.addr, 3), (light.addr, 1)],
    )
    .await;

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hello"}]
    });

    // Send 40 requests so the ratio is statistically clear.
    const TOTAL: usize = 40;
    for _ in 0..TOTAL {
        let resp = client
            .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await
            .expect("request failed");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    let heavy_count = heavy.request_count();
    let light_count = light.request_count();

    assert_eq!(
        heavy_count + light_count,
        TOTAL,
        "total requests should be {TOTAL}"
    );

    // Heavy endpoint (weight 3) should get ~75% of traffic.
    // Light endpoint (weight 1) should get ~25%.
    // With 40 requests: heavy=30, light=10. Allow ±2 for rounding.
    assert!(
        (28..=32).contains(&heavy_count),
        "heavy endpoint (weight 3) should get ~75% of traffic, got {heavy_count}/{TOTAL}"
    );
    assert!(
        (8..=12).contains(&light_count),
        "light endpoint (weight 1) should get ~25% of traffic, got {light_count}/{TOTAL}"
    );
}

#[tokio::test]
async fn test_round_robin_equal_weights() {
    // With equal weights, both endpoints should get approximately equal traffic.
    let model = "balanced-model/v1";

    let runner_a = MockRunner::spawn(model).await;
    let runner_b = MockRunner::spawn(model).await;

    let proxy = TestProxy::spawn("http://127.0.0.1:1").await;
    insert_active_model_multi(
        &proxy.routing_cache,
        model,
        vec![(runner_a.addr, 1), (runner_b.addr, 1)],
    )
    .await;

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": "Hi"}]
    });

    const TOTAL: usize = 20;
    for _ in 0..TOTAL {
        let _ = client
            .post(format!("{}/v1/chat/completions", proxy.proxy_url()))
            .json(&payload)
            .send()
            .await;
    }

    let count_a = runner_a.request_count();
    let count_b = runner_b.request_count();

    assert_eq!(count_a + count_b, TOTAL);
    // Allow ±2 from perfect split of 10 each.
    assert!(
        (8..=12).contains(&count_a),
        "equal weights should split evenly, got a={count_a} b={count_b}"
    );
}
