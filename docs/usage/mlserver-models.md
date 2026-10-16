# Deploying models with MLServer

The MLServer runner serves predictive, ONNX, and Hugging Face models through the KServe V2 Open
Inference Protocol (OIP). Use this guide to prepare model files on shared storage and deploy them
from the Sardeenz dashboard.

## Before you deploy

Make sure that:

- an MLServer runner module is `IMPORTED` in **Catalog**;
- at least one online worker advertises the `mlserver` runner type; the standard deployment uses
  `SARDEENZ_RUNNER_TYPES=vllm,mlserver`; and
- the model is stored below the shared weights root (normally `/weights`).

The deployment form's **Model Path** must identify a model directory, not an individual artifact.
The weights browser is a generic directory browser: a directory appearing as selectable does not
guarantee that the selected MLServer module contains a runtime for its file format.

## Recommended directory layout

Include a `model-settings.json` whenever the model is a file-based artifact or its directory
contains more than one possible artifact. This makes runtime and file selection explicit.

For a scikit-learn model:

```text
/weights/iris-classifier/
├── model.joblib
└── model-settings.json
```

```json
{
  "name": "iris-classifier",
  "implementation": "mlserver_sklearn.SKLearnModel",
  "parameters": {
    "uri": "./model.joblib"
  }
}
```

Enter `/weights/iris-classifier` as **Model Path**. The `parameters.uri` value may name the model
directory or a file inside it. A relative value is resolved from the model directory. Absolute or
relative paths that resolve outside that directory are rejected, including symlink escapes.

Sardeenz always replaces the settings file's `name` with the deployment's served model name. This
keeps routing identity independent from the name bundled with the artifact.

For a Hugging Face repository, point `parameters.uri` at the directory:

```text
/weights/sentiment-model/
├── config.json
├── model.safetensors
├── tokenizer.json
└── model-settings.json
```

```json
{
  "name": "sentiment-model",
  "implementation": "mlserver_huggingface.HuggingFaceRuntime",
  "parameters": {
    "uri": "."
  }
}
```

All model content must already be on shared storage. The runner sets `HF_HUB_OFFLINE=1` and does
not download missing files at runtime.

For an ONNX model, see the dedicated walkthrough below: no settings file is needed when the
directory holds a single `.onnx` file.

## Deploying an ONNX model

ONNX exports (sklearn-onnx, `torch.onnx`, tf2onnx, or similar) are served by the ONNX runtime
that the Sardeenz shim ships inside the MLServer SIF and executes with onnxruntime. Hugging Face
models exported with optimum are transformer pipelines, not raw graphs: keep them on the Hugging
Face runtime.

### 1. Stage the model

Put the exported file in its own directory below the weights root. Nothing else is required:

```text
/weights/accident-detection/
└── accident_detect.onnx
```

The file name does not matter as long as it is the only `.onnx` file in the directory.

### 2. Add `model-settings.json` only when needed

Add a settings file when the directory holds several `.onnx` files, when you want to force a
provider or pass onnxruntime options, or when the directory also contains scikit-learn or Hugging
Face artifacts that automatic detection would select first:

```json
{
  "name": "accident-detection",
  "implementation": "sardeenz_mlserver_runner.onnx_runtime.ONNXRuntimeModel",
  "parameters": {
    "uri": "./accident_detect.onnx",
    "version": "v0.1.0",
    "extra": {
      "providers": ["CUDAExecutionProvider", "CPUExecutionProvider"]
    }
  }
}
```

The `implementation` must be exactly the string shown; Seldon publishes no `mlserver_onnx`
runtime. As with every runtime, `name` is replaced by the deployment's served model name.
Supported `extra` keys:

| Key                | Meaning                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers`        | onnxruntime execution providers in priority order. Default: `CUDAExecutionProvider` when the SIF has it, then `CPUExecutionProvider`. With an explicit list, a provider that fails to initialize is a load error; with the default, the runtime logs a warning and serves on CPU. |
| `provider_options` | Per-provider options, for example `{"CUDAExecutionProvider": {"device_id": 0}}`.                                                                                                                                                                                                  |
| `session_options`  | Attributes set on `onnxruntime.SessionOptions`, for example `{"intra_op_num_threads": 4}`.                                                                                                                                                                                        |

### 3. Deploy

In the dashboard, enter `/weights/accident-detection` as **Model Path**, choose the MLServer runner
type and an `IMPORTED` MLServer module that contains ONNX support (`mlserver-1.7.1`, built as
`1.7.1-rc4` or later), and deploy. The runner log reports the active providers, for example
`providers=['CUDAExecutionProvider', 'CPUExecutionProvider']`; CPU only means the CUDA provider
failed to initialize, which the runtime also logs as a warning (see Troubleshooting). To refuse a
CPU fallback outright, pin `"providers": ["CUDAExecutionProvider"]` in `model-settings.json`: the
load then fails instead of serving silently on CPU.

### 4. Inspect the graph signature

The runtime publishes the graph's inputs and outputs on the V2 metadata endpoint. Symbolic
dimensions such as the batch size appear as `-1`:

```bash
curl -s "$PROXY/oip/v2/models/<served-model-name>"
```

```json
{
  "name": "accident-detection",
  "inputs": [{ "name": "images", "datatype": "FP32", "shape": [-1, 3, 224, 224] }],
  "outputs": [{ "name": "output0", "datatype": "FP32", "shape": [-1, 2] }]
}
```

### 5. Run inference

Send a KServe V2 request whose inputs are named after the graph's inputs. A single-input model
also accepts any one input name:

```bash
curl -s "$PROXY/oip/v2/models/<served-model-name>/infer" \
  -H 'content-type: application/json' \
  -d '{
    "inputs": [
      { "name": "images", "datatype": "FP32", "shape": [1, 3, 224, 224], "data": [0.0, 0.1, ...] }
    ]
  }'
```

Every model output is returned under its own name unless the request lists `outputs`. Numeric
inputs are cast to the declared type, so `FP64` data sent to a `tensor(float)` input works.
Non-tensor outputs, such as the per-row probability maps emitted by a sklearn-onnx classifier's
ZipMap node, are returned as `BYTES` JSON documents. MLServer encodes one-dimensional data as
`[N, 1]`; the runtime squeezes that trailing dimension when the graph declares a rank-1 input.

## Automatic detection

When `model-settings.json` is absent, the shim examines only the top level of the selected model
directory:

| Files found                                                                  | Selected implementation                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `*.joblib`, `*.pkl`, `*.bst`, or `model.json`                                | `mlserver_sklearn.SKLearnModel`                          |
| `config.json` plus `*.safetensors`, `pytorch_model.bin`, or `tokenizer.json` | `mlserver_huggingface.HuggingFaceRuntime`                |
| `*.onnx` (and none of the combinations above)                                | `sardeenz_mlserver_runner.onnx_runtime.ONNXRuntimeModel` |
| No recognized combination                                                    | Deployment fails during runner startup                   |

Automatic detection selects an implementation, not a particular artifact. It generates settings
whose `parameters.uri` is the whole model directory. For file-based models—especially directories
containing multiple files—provide `model-settings.json` with the exact artifact URI.

The current official MLServer SIF packages the scikit-learn, Hugging Face, and ONNX
(onnxruntime) runtimes. GGUF, raw `.pt`/`.pth`, MLflow, LightGBM, and XGBoost runtimes are not
included; convert such models to ONNX to serve them. Although `.bst` and `model.json` are
recognized by the current heuristic, they are routed to the scikit-learn implementation; do not
assume that recognition provides native XGBoost support. Supporting another format requires an
MLServer SIF that installs its runtime and settings naming that runtime's implementation. SIFs
built before ONNX support was added do not contain onnxruntime; re-import a current build.

## What happens at startup

After placement, the worker:

1. resolves the selected runtime module to `/modules/<runtime-module>.sif`;
2. starts the SIF with Apptainer and binds the shared weights and scratch directories;
3. invokes `python3 -m sardeenz_mlserver_runner --model <model-path> ...` inside the SIF;
4. copies or generates `model-settings.json` in a writable temporary repository under `/scratch`;
5. starts `mlserver start <temporary-repository>`; and
6. marks the deployment ready when MLServer reports the served model ready.

Inference is exposed through the proxy under `/oip/v2/...`, not the OpenAI-compatible
`/openai/v1/...` path. For example, model readiness is available at
`/oip/v2/models/<served-model-name>/ready`; inference uses the KServe V2 request schema at
`/oip/v2/models/<served-model-name>/infer`.

Sleeping an MLServer model unloads it through the KServe repository API. Waking it loads the model
again from the generated repository. This is not the same as vLLM's explicit weight offload: the
operating-system page cache may keep files warm, but that is not guaranteed.

## Cancel a deployment

While a model is `STARTING`, use **Stop** to cancel the in-progress runner launch while retaining
the model configuration, or **Delete** to cancel the launch and remove the configuration. Sardeenz
resolves the worker's in-progress runner by instance ID and terminates it; neither action requires
a force operation. A `PENDING` deployment has no worker target yet and cannot be cancelled until it
is placed.

## Troubleshooting

- **Could not infer an MLServer runtime:** add an explicit `model-settings.json`, and confirm that
  the selected SIF contains the requested implementation.
- **Model path does not exist or escapes the weights root:** select a real directory strictly below
  `/weights`; the bare weights root is not a deployable model directory.
- **Model load fails after implementation detection:** for a file-based model, set
  `parameters.uri` to the exact artifact rather than the directory.
- **`No *.onnx artifact found` or `Several *.onnx artifacts`:** the directory has zero or more
  than one `.onnx` file; name the one to serve in `parameters.uri`.
- **`Requested onnxruntime providers not available`:** the SIF's onnxruntime build lacks a
  provider listed in `extra.providers`, or the imported SIF predates ONNX support. Remove the
  entry to let the runtime fall back, or re-import a current MLServer SIF.
- **ONNX model runs on CPU although a GPU was assigned:** the CUDA execution provider failed to
  initialize; the runner log shows the onnxruntime message and a `falling back to` warning from
  the runtime, and the instance reports 0 B of measured VRAM. `libcudnn.so.9: cannot open shared
object file` means the SIF predates `1.7.1-rc4` (its CUDA 12 libraries were not on the loader
  path); re-import a current SIF. Otherwise the host driver is usually older than the CUDA 12.8
  libraries bundled in the SIF (570 or newer is required).
- **Request inputs do not match the model's inputs:** name the request inputs after the graph's
  inputs as listed by `GET /oip/v2/models/<served-model-name>`.
- **MLServer is absent from Runner Type:** confirm an online worker advertises `mlserver` through
  `SARDEENZ_RUNNER_TYPES` and restart the worker after changing that setting.
- **The model is not found during inference:** use the deployment's served model name in the OIP
  URL, not the source directory name or the original name from `model-settings.json`.
- **Additional engine arguments have no effect:** the current MLServer runner ignores deployment
  `engineArgs`; configure MLServer through `model-settings.json` instead.
- **`Permission denied` for `.metrics` or `.envs`:** upgrade the worker so it redirects MLServer's
  metrics and inference-environment directories under `/scratch`. Current runner shims also use a
  writable working directory and provide writable fallbacks. The preceding Apptainer warning about
  remounting `/.singularity.d/libs` read-only is non-fatal; the Python traceback identifies the
  actual startup failure.
- **`Worker-N` repeatedly exits with “There is no current event loop”:** upgrade the worker. It
  disables MLServer 1.7.1's redundant internal inference pool by default; Sardeenz already isolates
  each model in its own runner process. Do not set `SARDEENZ_MLSERVER_PARALLEL_WORKERS` above zero
  unless the selected MLServer release has been validated with Python 3.12 and uvloop.

For importing the runner SIF, see the [runner catalog guide](runner-catalog.md). For the HTTP API
families, see the [API reference](api-reference.md). Implementation and runner-contract details
are in the [MLServer runner README](../../runners/mlserver/README.md).
