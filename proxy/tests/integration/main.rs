// Integration tests for the Sardeenz routing proxy.
//
// These tests spin up real HTTP servers (mock runner + mock control plane)
// and a full proxy instance, then exercise end-to-end flows without any
// Redis dependency — the routing map is injected directly into
// `RoutingMapCache`.

mod common;

mod test_active_model;
mod test_circuit_breaker;
mod test_health;
mod test_model_states;
mod test_models_endpoint;
mod test_parked_state_transitions;
mod test_parking_leak;
mod test_parking_limits;
mod test_parking_timeout;
mod test_sleeping_model;
mod test_streaming;
mod test_thundering_herd;
mod test_unknown_model;
mod test_wake_failure;
mod test_wake_response;
mod test_weighted_round_robin;

#[cfg(feature = "redis-integration")]
mod test_redis;
