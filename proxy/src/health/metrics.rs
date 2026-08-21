use metrics_exporter_prometheus::PrometheusBuilder;

pub fn setup_metrics() -> metrics_exporter_prometheus::PrometheusHandle {
    let builder = PrometheusBuilder::new();
    builder.install_recorder().expect("failed to install Prometheus recorder")
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
