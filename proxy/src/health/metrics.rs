use metrics_exporter_prometheus::{Matcher, PrometheusBuilder};

/// Bucket boundaries (seconds) for `sardeenz_proxy_request_duration_seconds`.
///
/// Explicit buckets are mandatory: `metrics-exporter-prometheus` renders a histogram as a
/// Prometheus *summary* (`_sum`/`_count`/`quantile="…"`, no `_bucket` series) when no buckets are
/// configured for it. The dashboard's `histogram_quantile(rate(..._bucket[5m]))` queries need the
/// `_bucket` series, so every histogram metric must have its buckets set here (see #201).
const REQUEST_DURATION_BUCKETS: &[f64] =
    &[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0];

/// Bucket boundaries (seconds) for `sardeenz_proxy_parking_duration_seconds`. See
/// [`REQUEST_DURATION_BUCKETS`] for why explicit buckets are required.
const PARKING_DURATION_BUCKETS: &[f64] = &[0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0];

/// Builds the `PrometheusBuilder` used by both the installed recorder and tests, with explicit
/// buckets set on every histogram metric so they render as Prometheus histograms.
pub fn prometheus_builder() -> PrometheusBuilder {
    PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full("sardeenz_proxy_request_duration_seconds".to_string()),
            REQUEST_DURATION_BUCKETS,
        )
        .expect("valid bucket boundaries for sardeenz_proxy_request_duration_seconds")
        .set_buckets_for_metric(
            Matcher::Full("sardeenz_proxy_parking_duration_seconds".to_string()),
            PARKING_DURATION_BUCKETS,
        )
        .expect("valid bucket boundaries for sardeenz_proxy_parking_duration_seconds")
}

pub fn setup_metrics() -> metrics_exporter_prometheus::PrometheusHandle {
    prometheus_builder().install_recorder().expect("failed to install Prometheus recorder")
}

pub fn describe_metrics() {
    use metrics::describe_counter;
    use metrics::describe_gauge;
    use metrics::describe_histogram;

    describe_counter!(
        "sardeenz_proxy_requests_total",
        "Total requests, labeled by model, endpoint, status code"
    );
    describe_histogram!(
        "sardeenz_proxy_request_duration_seconds",
        "Request latency (excluding parking wait time)"
    );
    describe_gauge!("sardeenz_proxy_active_connections", "Currently active forwarded connections");
    describe_gauge!(
        "sardeenz_proxy_parked_connections",
        "Currently parked connections, labeled by model"
    );
    describe_counter!(
        "sardeenz_proxy_wake_triggers_total",
        "Wake triggers sent to the control plane"
    );
    describe_histogram!(
        "sardeenz_proxy_parking_duration_seconds",
        "Time spent parked before forwarding"
    );
    describe_gauge!(
        "sardeenz_proxy_circuit_breaker_state",
        "Circuit breaker state per endpoint (0=closed, 1=open, 2=half-open)"
    );
    describe_counter!(
        "sardeenz_proxy_routing_parse_errors_total",
        "Routing entries that failed to deserialize during Redis sync, labeled by model"
    );
}

#[cfg(test)]
mod tests {
    use metrics::histogram;

    use super::*;

    #[test]
    fn histograms_render_with_explicit_buckets_not_as_summaries() {
        let recorder = prometheus_builder().build_recorder();
        let handle = recorder.handle();

        metrics::with_local_recorder(&recorder, || {
            histogram!("sardeenz_proxy_request_duration_seconds").record(0.2);
            histogram!("sardeenz_proxy_parking_duration_seconds").record(2.0);
        });

        let rendered = handle.render();

        assert!(
            rendered.contains(r#"sardeenz_proxy_request_duration_seconds_bucket{le="0.01"}"#),
            "expected request duration bucket le=\"0.01\", got: {rendered}"
        );
        assert!(
            rendered.contains(r#"sardeenz_proxy_request_duration_seconds_bucket{le="+Inf"}"#),
            "expected request duration bucket le=\"+Inf\", got: {rendered}"
        );
        assert!(
            rendered.contains(r#"sardeenz_proxy_parking_duration_seconds_bucket{le="0.5"}"#),
            "expected parking duration bucket le=\"0.5\", got: {rendered}"
        );
        assert!(
            rendered.contains(r#"sardeenz_proxy_parking_duration_seconds_bucket{le="+Inf"}"#),
            "expected parking duration bucket le=\"+Inf\", got: {rendered}"
        );
        assert!(
            !rendered.contains("quantile="),
            "histograms should render as buckets, not summaries with quantiles: {rendered}"
        );
    }
}
