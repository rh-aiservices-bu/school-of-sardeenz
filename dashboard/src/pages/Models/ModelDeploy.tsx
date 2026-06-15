import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PageSection,
  Content,
  Form,
  FormGroup,
  FormHelperText,
  TextInput,
  TextArea,
  FormSelect,
  FormSelectOption,
  Switch,
  ActionGroup,
  Button,
  Alert,
  AlertVariant,
  Card,
  CardBody,
  HelperText,
  HelperTextItem,
} from '@patternfly/react-core';
import { useDeployModel } from '../../hooks/useModels';
import type { ModelDeploymentRequest } from '../../api/client';

const GIB = 1024 ** 3;

const RUNNER_OPTIONS = [
  { value: 'vllm', label: 'vLLM' },
  { value: 'triton', label: 'Triton' },
];

const DEVICE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'CUDA', label: 'CUDA' },
  { value: 'ROCM', label: 'ROCM' },
  { value: 'CPU', label: 'CPU' },
];

interface FormState {
  modelName: string;
  runnerType: string;
  modelPath: string;
  requiredMemoryGib: string;
  deviceType: string;
  tensorParallel: string;
  pinned: boolean;
  engineConfig: string;
}

interface FormErrors {
  modelName?: string;
  runnerType?: string;
  modelPath?: string;
  requiredMemoryGib?: string;
  tensorParallel?: string;
  engineConfig?: string;
}

function validate(form: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.modelName.trim()) {
    errors.modelName = 'Model name is required.';
  }

  if (!form.runnerType) {
    errors.runnerType = 'Runner type is required.';
  }

  if (!form.modelPath.trim()) {
    errors.modelPath = 'Model path is required.';
  } else if (!form.modelPath.startsWith('/')) {
    errors.modelPath = 'Model path must start with /.';
  }

  const mem = parseFloat(form.requiredMemoryGib);
  if (!form.requiredMemoryGib.trim() || isNaN(mem) || mem <= 0) {
    errors.requiredMemoryGib = 'Required memory must be a positive number.';
  }

  const tp = parseInt(form.tensorParallel, 10);
  if (isNaN(tp) || tp < 1) {
    errors.tensorParallel = 'Tensor parallelism must be at least 1.';
  }

  if (form.engineConfig.trim()) {
    try {
      JSON.parse(form.engineConfig);
    } catch {
      errors.engineConfig = 'Engine config must be valid JSON.';
    }
  }

  return errors;
}

interface FieldHelperProps {
  hint?: string;
  error?: string;
  showError: boolean;
  fieldId: string;
}

function FieldHelper({ hint, error, showError, fieldId }: FieldHelperProps) {
  const hasError = showError && !!error;
  if (!hint && !hasError) return null;
  return (
    <FormHelperText>
      <HelperText>
        {hasError ? (
          <HelperTextItem id={`${fieldId}-helper`} variant="error">{error}</HelperTextItem>
        ) : hint ? (
          <HelperTextItem id={`${fieldId}-helper`}>{hint}</HelperTextItem>
        ) : null}
      </HelperText>
    </FormHelperText>
  );
}

export function ModelDeploy() {
  const navigate = useNavigate();
  const deployModel = useDeployModel();

  const [form, setForm] = useState<FormState>({
    modelName: '',
    runnerType: 'vllm',
    modelPath: '',
    requiredMemoryGib: '',
    deviceType: '',
    tensorParallel: '1',
    pinned: false,
    engineConfig: '',
  });

  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    const updated = { ...form, [field]: value };
    setForm(updated);
    if (submitted) {
      setErrors(validate(updated));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const body: ModelDeploymentRequest = {
      modelName: form.modelName.trim(),
      runnerType: form.runnerType,
      modelPath: form.modelPath.trim(),
      requiredMemory: Math.round(parseFloat(form.requiredMemoryGib) * GIB),
      tensorParallel: parseInt(form.tensorParallel, 10),
      pinned: form.pinned,
    };

    if (form.deviceType) {
      body.deviceType = form.deviceType;
    }

    if (form.engineConfig.trim()) {
      body.engineConfig = JSON.parse(form.engineConfig) as Record<string, unknown>;
    }

    deployModel.mutate(body, {
      onSuccess: () => {
        void navigate(`/models/${encodeURIComponent(body.modelName)}`);
      },
    });
  };

  return (
    <PageSection>
      <Content>
        <h1>Deploy Model</h1>
      </Content>

      <Card style={{ maxWidth: '720px' }}>
        <CardBody>
          {deployModel.isError && (
            <Alert
              variant={AlertVariant.danger}
              title="Deployment failed"
              isInline
              style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
            >
              {deployModel.error instanceof Error
                ? deployModel.error.message
                : 'An unexpected error occurred.'}
            </Alert>
          )}

          <Form onSubmit={handleSubmit} noValidate>
            <FormGroup label="Model Name" isRequired fieldId="model-name">
              <TextInput
                id="model-name"
                value={form.modelName}
                onChange={(_ev, val) => set('modelName', val)}
                isRequired
                aria-invalid={submitted && !!errors.modelName}
                aria-describedby="model-name-helper"
                placeholder="meta-llama/Llama-3.1-8B-Instruct"
              />
              <FieldHelper
                error={errors.modelName}
                showError={submitted}
                fieldId="model-name"
              />
            </FormGroup>

            <FormGroup label="Runner Type" isRequired fieldId="runner-type">
              <FormSelect
                id="runner-type"
                value={form.runnerType}
                onChange={(_ev, val) => set('runnerType', val)}
                aria-label="Runner type"
              >
                {RUNNER_OPTIONS.map((opt) => (
                  <FormSelectOption key={opt.value} value={opt.value} label={opt.label} />
                ))}
              </FormSelect>
              <FieldHelper
                error={errors.runnerType}
                showError={submitted}
                fieldId="runner-type"
              />
            </FormGroup>

            <FormGroup label="Model Path" isRequired fieldId="model-path">
              <TextInput
                id="model-path"
                value={form.modelPath}
                onChange={(_ev, val) => set('modelPath', val)}
                isRequired
                aria-invalid={submitted && !!errors.modelPath}
                aria-describedby="model-path-helper"
                placeholder="/models/meta-llama/Llama-3.1-8B-Instruct"
              />
              <FieldHelper
                hint="Absolute path to model weights on shared storage."
                error={errors.modelPath}
                showError={submitted}
                fieldId="model-path"
              />
            </FormGroup>

            <FormGroup label="Required Memory (GiB)" isRequired fieldId="required-memory">
              <TextInput
                id="required-memory"
                type="number"
                value={form.requiredMemoryGib}
                onChange={(_ev, val) => set('requiredMemoryGib', val)}
                isRequired
                aria-invalid={submitted && !!errors.requiredMemoryGib}
                aria-describedby="required-memory-helper"
                placeholder="16"
                min={0}
                step={0.5}
              />
              <FieldHelper
                hint="Estimated device memory in GiB. Used for placement."
                error={errors.requiredMemoryGib}
                showError={submitted}
                fieldId="required-memory"
              />
            </FormGroup>

            <FormGroup label="Device Type" fieldId="device-type">
              <FormSelect
                id="device-type"
                value={form.deviceType}
                onChange={(_ev, val) => set('deviceType', val)}
                aria-label="Device type"
              >
                {DEVICE_OPTIONS.map((opt) => (
                  <FormSelectOption key={opt.value} value={opt.value} label={opt.label} />
                ))}
              </FormSelect>
              <FieldHelper
                hint="Required device type. Leave blank to accept any compatible device."
                showError={false}
                fieldId="device-type"
              />
            </FormGroup>

            <FormGroup label="Tensor Parallelism" fieldId="tensor-parallel">
              <TextInput
                id="tensor-parallel"
                type="number"
                value={form.tensorParallel}
                onChange={(_ev, val) => set('tensorParallel', val)}
                aria-invalid={submitted && !!errors.tensorParallel}
                aria-describedby="tensor-parallel-helper"
                min={1}
                step={1}
              />
              <FieldHelper
                hint="Number of devices to split the model across on a single worker."
                error={errors.tensorParallel}
                showError={submitted}
                fieldId="tensor-parallel"
              />
            </FormGroup>

            <FormGroup label="Pinned" fieldId="pinned">
              <Switch
                id="pinned"
                label="Pinned"
                isChecked={form.pinned}
                onChange={(_ev, checked) => set('pinned', checked)}
              />
              <FieldHelper
                hint="Pinned models cannot be evicted by the LRU eviction engine."
                showError={false}
                fieldId="pinned"
              />
            </FormGroup>

            <FormGroup label="Engine Config (JSON)" fieldId="engine-config">
              <TextArea
                id="engine-config"
                value={form.engineConfig}
                onChange={(_ev, val) => set('engineConfig', val)}
                aria-invalid={submitted && !!errors.engineConfig}
                aria-describedby="engine-config-helper"
                placeholder={'{\n  "max_model_len": 4096\n}'}
                rows={5}
                style={{ fontFamily: 'monospace' }}
              />
              <FieldHelper
                hint="Optional engine-specific configuration. Must be valid JSON if provided."
                error={errors.engineConfig}
                showError={submitted}
                fieldId="engine-config"
              />
            </FormGroup>

            <ActionGroup>
              <Button
                variant="primary"
                type="submit"
                isLoading={deployModel.isPending}
                isDisabled={deployModel.isPending}
              >
                Deploy
              </Button>
              <Button variant="link" onClick={() => void navigate('/models')}>
                Cancel
              </Button>
            </ActionGroup>
          </Form>
        </CardBody>
      </Card>
    </PageSection>
  );
}
