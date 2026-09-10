# Deploying models with MLServer

The MLServer runner serves predictive and Hugging Face models through the KServe V2 Open
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

## Automatic detection

When `model-settings.json` is absent, the shim examines only the top level of the selected model
directory:

| Files found                                                                  | Selected implementation                   |
| ---------------------------------------------------------------------------- | ----------------------------------------- |
| `*.joblib`, `*.pkl`, `*.bst`, or `model.json`                                | `mlserver_sklearn.SKLearnModel`           |
| `config.json` plus `*.safetensors`, `pytorch_model.bin`, or `tokenizer.json` | `mlserver_huggingface.HuggingFaceRuntime` |
| No recognized combination                                                    | Deployment fails during runner startup    |

Automatic detection selects an implementation, not a particular artifact. It generates settings
whose `parameters.uri` is the whole model directory. For file-based models—especially directories
containing multiple files—provide `model-settings.json` with the exact artifact URI.

The current official MLServer SIF packages only the scikit-learn and Hugging Face runtimes. ONNX,
GGUF, raw `.pt`/`.pth`, MLflow, LightGBM, and XGBoost runtimes are not included. Although `.bst`
and `model.json` are recognized by the current heuristic, they are routed to the scikit-learn
implementation; do not assume that recognition provides native XGBoost support. Supporting another
format requires an MLServer SIF that installs its runtime and settings naming that runtime's
implementation.

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

## Troubleshooting

- **Could not infer an MLServer runtime:** add an explicit `model-settings.json`, and confirm that
  the selected SIF contains the requested implementation.
- **Model path does not exist or escapes the weights root:** select a real directory strictly below
  `/weights`; the bare weights root is not a deployable model directory.
- **Model load fails after implementation detection:** for a file-based model, set
  `parameters.uri` to the exact artifact rather than the directory.
- **MLServer is absent from Runner Type:** confirm an online worker advertises `mlserver` through
  `SARDEENZ_RUNNER_TYPES` and restart the worker after changing that setting.
- **The model is not found during inference:** use the deployment's served model name in the OIP
  URL, not the source directory name or the original name from `model-settings.json`.
- **Additional engine arguments have no effect:** the current MLServer runner ignores deployment
  `engineArgs`; configure MLServer through `model-settings.json` instead.

For importing the runner SIF, see the [runner catalog guide](runner-catalog.md). For the HTTP API
families, see the [API reference](api-reference.md). Implementation and runner-contract details
are in the [MLServer runner README](../../runners/mlserver/README.md).
