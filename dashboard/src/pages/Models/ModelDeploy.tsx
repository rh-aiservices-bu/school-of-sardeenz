import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CatalogItemState } from '@sardeenz/types';
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
  InputGroup,
  InputGroupItem,
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
import { useCatalog } from '../../hooks/useCatalog';
import {
  useRunnerTypes,
  useWorkerCapabilities,
  computeDeviceOptions,
  reconcileRunnerType,
  reconcileDeviceType,
} from '../../hooks/useWorkers';
import { WeightsBrowserModal } from './WeightsBrowserModal';
import { DeployLogsModal } from '../../components/DeployLogsModal';
import type { ModelDeploymentRequest } from '../../api/client';
import { parseEngineArgs } from '../../utils/engineArgs';

const GIB = 1024 ** 3;

// Mirrors the runtimeModule pattern in the control-plane/worker contracts (it becomes a SIF
// filename segment: /modules/<runtimeModule>.sif).
const RUNTIME_MODULE_PATTERN = /^[A-Za-z0-9_.-]+$/;

interface FormState {
  modelName: string;
  runnerType: string;
  modelPath: string;
  requiredMemoryGib: string;
  deviceType: string;
  tensorParallel: string;
  runtimeModule: string;
  pinned: boolean;
  engineArgs: string;
}

interface FormErrors {
  modelName?: string;
  runnerType?: string;
  modelPath?: string;
  requiredMemoryGib?: string;
  tensorParallel?: string;
  runtimeModule?: string;
  engineArgs?: string;
}

function validate(form: FormState, t: TFunction<'models'>): FormErrors {
  const errors: FormErrors = {};

  if (!form.modelName.trim()) {
    errors.modelName = t('deploy.validation.modelNameRequired');
  }

  if (!form.runnerType) {
    errors.runnerType = t('deploy.validation.runnerTypeRequired');
  }

  if (!form.modelPath.trim()) {
    errors.modelPath = t('deploy.validation.modelPathRequired');
  } else if (!form.modelPath.startsWith('/')) {
    errors.modelPath = t('deploy.validation.modelPathStartsWithSlash');
  }

  const mem = parseFloat(form.requiredMemoryGib);
  if (!form.requiredMemoryGib.trim() || isNaN(mem) || mem <= 0) {
    errors.requiredMemoryGib = t('deploy.validation.requiredMemoryPositive');
  }

  const tp = parseInt(form.tensorParallel, 10);
  if (isNaN(tp) || tp < 1) {
    errors.tensorParallel = t('deploy.validation.tensorParallelMin');
  }

  if (!form.runtimeModule.trim()) {
    errors.runtimeModule = t('deploy.validation.runtimeModuleRequired');
  } else if (!RUNTIME_MODULE_PATTERN.test(form.runtimeModule.trim())) {
    errors.runtimeModule = t('deploy.validation.runtimeModulePattern');
  }

  if (form.engineArgs.trim()) {
    const result = parseEngineArgs(form.engineArgs);
    if (!result.ok) {
      errors.engineArgs =
        result.kind === 'prefix'
          ? t('deploy.validation.engineArgsFlagPrefix', {
              line: result.line,
              content: result.content,
            })
          : result.abbreviates
            ? t('deploy.validation.engineArgsAbbreviatesReserved', {
                flag: result.flag,
                reserved: result.abbreviates,
              })
            : t('deploy.validation.engineArgsReserved', { flag: result.flag });
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
          <HelperTextItem id={`${fieldId}-helper`} variant="error">
            {error}
          </HelperTextItem>
        ) : hint ? (
          <HelperTextItem id={`${fieldId}-helper`}>{hint}</HelperTextItem>
        ) : null}
      </HelperText>
    </FormHelperText>
  );
}

export function ModelDeploy() {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
  const navigate = useNavigate();
  const deployModel = useDeployModel();
  const { data: catalog } = useCatalog();
  const { options: runnerOptions, isFallback: runnerFallback } = useRunnerTypes();
  const { capabilities } = useWorkerCapabilities();

  const [form, setForm] = useState<FormState>({
    modelName: '',
    runnerType: 'vllm',
    modelPath: '',
    requiredMemoryGib: '',
    deviceType: '',
    tensorParallel: '1',
    runtimeModule: '',
    pinned: false,
    engineArgs: '',
  });

  const [errors, setErrors] = useState<FormErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [logsModalModelName, setLogsModalModelName] = useState<string | null>(null);

  // Runtime modules that are both installed (IMPORTED) and built for the selected runner. The
  // catalog entry's sifName is the runtimeModule value (→ /modules/<sifName>.sif).
  const availableModules = useMemo(
    () =>
      (catalog?.runners ?? [])
        .filter(
          (item) =>
            item.entry.runnerType === form.runnerType &&
            item.status.state === CatalogItemState.IMPORTED,
        )
        .map((item) => item.entry),
    [catalog, form.runnerType],
  );

  const deviceOptions = useMemo(
    () =>
      computeDeviceOptions(capabilities, form.runnerType, t('deploy.fields.deviceTypeAny')).options,
    [capabilities, form.runnerType, t],
  );

  // Reconcile the default/selected runnerType against live options so the form never
  // submits a runner no worker can serve. Guarded: leaves a still-valid choice intact.
  useEffect(() => {
    setForm((prev) => {
      const next = reconcileRunnerType(prev.runnerType, runnerOptions);
      if (next === prev.runnerType) return prev;
      // Runner changed → its runtimeModule selection is no longer valid (modules are
      // runner-specific), mirroring the reset in `set()` for manual runner changes. Same
      // for deviceType: recompute the new runner's device options and drop the selection
      // if it no longer applies (e.g. was 'CUDA', new runner is CPU-only).
      const nextDeviceOptions = computeDeviceOptions(
        capabilities,
        next,
        t('deploy.fields.deviceTypeAny'),
      ).options;
      return {
        ...prev,
        runnerType: next,
        runtimeModule: '',
        deviceType: reconcileDeviceType(prev.deviceType, nextDeviceOptions),
      };
    });
  }, [runnerOptions, capabilities, t]);

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    const updated = { ...form, [field]: value };
    // Modules and deviceType are runner-specific, so a runner change invalidates
    // selections that don't apply to the new runner.
    if (field === 'runnerType') {
      updated.runtimeModule = '';
      const nextDeviceOptions = computeDeviceOptions(
        capabilities,
        value as FormState['runnerType'],
        t('deploy.fields.deviceTypeAny'),
      ).options;
      updated.deviceType = reconcileDeviceType(form.deviceType, nextDeviceOptions);
    }
    setForm(updated);
    if (submitted) {
      setErrors(validate(updated, t));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const errs = validate(form, t);
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

    if (form.runtimeModule.trim()) {
      body.runtimeModule = form.runtimeModule.trim();
    }

    if (form.engineArgs.trim()) {
      const result = parseEngineArgs(form.engineArgs);
      // validate() already blocked submit on !result.ok; only push a non-empty parsed array.
      if (result.ok && result.args.length > 0) {
        body.engineArgs = result.args;
      }
    }

    deployModel.mutate(body, {
      onSuccess: () => {
        setLogsModalModelName(body.modelName);
      },
    });
  };

  const closeLogsModal = () => {
    const deployedModelName = logsModalModelName;
    setLogsModalModelName(null);
    if (deployedModelName) {
      void navigate(`/models/${encodeURIComponent(deployedModelName)}`);
    }
  };

  return (
    <PageSection>
      <Content>
        <h1>{t('deploy.title')}</h1>
      </Content>

      <Card style={{ maxWidth: '720px' }}>
        <CardBody>
          {deployModel.isError && (
            <Alert
              variant={AlertVariant.danger}
              title={t('deploy.errors.deploymentFailed')}
              isInline
              style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
            >
              {deployModel.error instanceof Error
                ? deployModel.error.message
                : tCommon('errors.unexpected')}
            </Alert>
          )}

          <Form onSubmit={handleSubmit} noValidate>
            <FormGroup label={t('deploy.fields.runnerType')} isRequired fieldId="runner-type">
              <FormSelect
                id="runner-type"
                value={form.runnerType}
                onChange={(_ev, val) => set('runnerType', val)}
                aria-label={t('deploy.fields.runnerType')}
              >
                {runnerOptions.map((opt) => (
                  <FormSelectOption key={opt.value} value={opt.value} label={opt.label} />
                ))}
              </FormSelect>
              {runnerFallback && (
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem variant="warning">
                      {t('deploy.hints.runnerTypeFallback')}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              )}
              <FieldHelper error={errors.runnerType} showError={submitted} fieldId="runner-type" />
            </FormGroup>

            <FormGroup label={t('deploy.fields.runtimeModule')} isRequired fieldId="runtime-module">
              <FormSelect
                id="runtime-module"
                value={form.runtimeModule}
                onChange={(_ev, val) => set('runtimeModule', val)}
                aria-label={t('deploy.fields.runtimeModule')}
                aria-invalid={submitted && !!errors.runtimeModule}
                validated={submitted && errors.runtimeModule ? 'error' : 'default'}
              >
                <FormSelectOption
                  value=""
                  label={t('deploy.fields.runtimeModulePlaceholder')}
                  isPlaceholder
                  isDisabled
                />
                {availableModules.map((entry) => (
                  <FormSelectOption
                    key={entry.sifName}
                    value={entry.sifName}
                    label={entry.sifName}
                  />
                ))}
              </FormSelect>
              <FieldHelper
                hint={
                  availableModules.length === 0
                    ? t('deploy.hints.runtimeModuleNone')
                    : t('deploy.hints.runtimeModule')
                }
                error={errors.runtimeModule}
                showError={submitted}
                fieldId="runtime-module"
              />
            </FormGroup>

            <FormGroup label={t('deploy.fields.modelPath')} isRequired fieldId="model-path">
              <InputGroup>
                <InputGroupItem isFill>
                  <TextInput
                    id="model-path"
                    value={form.modelPath}
                    onChange={(_ev, val) => set('modelPath', val)}
                    isRequired
                    aria-invalid={submitted && !!errors.modelPath}
                    aria-describedby="model-path-helper"
                    placeholder="/models/meta-llama/Llama-3.1-8B-Instruct"
                  />
                </InputGroupItem>
                <InputGroupItem>
                  <Button variant="control" onClick={() => setBrowseOpen(true)}>
                    {t('deploy.browse.button')}
                  </Button>
                </InputGroupItem>
              </InputGroup>
              <FieldHelper
                hint={t('deploy.hints.modelPath')}
                error={errors.modelPath}
                showError={submitted}
                fieldId="model-path"
              />
            </FormGroup>

            <FormGroup label={t('deploy.fields.modelName')} isRequired fieldId="model-name">
              <TextInput
                id="model-name"
                value={form.modelName}
                onChange={(_ev, val) => set('modelName', val)}
                isRequired
                aria-invalid={submitted && !!errors.modelName}
                aria-describedby="model-name-helper"
                placeholder="meta-llama/Llama-3.1-8B-Instruct"
              />
              <FieldHelper error={errors.modelName} showError={submitted} fieldId="model-name" />
            </FormGroup>

            <FormGroup
              label={t('deploy.fields.requiredMemory')}
              isRequired
              fieldId="required-memory"
            >
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
                hint={t('deploy.hints.requiredMemory')}
                error={errors.requiredMemoryGib}
                showError={submitted}
                fieldId="required-memory"
              />
            </FormGroup>

            <FormGroup label={t('deploy.fields.deviceType')} fieldId="device-type">
              <FormSelect
                id="device-type"
                value={form.deviceType}
                onChange={(_ev, val) => set('deviceType', val)}
                aria-label={t('deploy.fields.deviceType')}
              >
                {deviceOptions.map((opt) => (
                  <FormSelectOption key={opt.value} value={opt.value} label={opt.label} />
                ))}
              </FormSelect>
              <FieldHelper
                hint={t('deploy.hints.deviceType')}
                showError={false}
                fieldId="device-type"
              />
            </FormGroup>

            <FormGroup label={t('deploy.fields.tensorParallel')} fieldId="tensor-parallel">
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
                hint={t('deploy.hints.tensorParallel')}
                error={errors.tensorParallel}
                showError={submitted}
                fieldId="tensor-parallel"
              />
            </FormGroup>

            <FormGroup label={t('deploy.fields.pinned')} fieldId="pinned">
              <Switch
                id="pinned"
                label={t('deploy.fields.pinned')}
                isChecked={form.pinned}
                onChange={(_ev, checked) => set('pinned', checked)}
              />
              <FieldHelper hint={t('deploy.hints.pinned')} showError={false} fieldId="pinned" />
            </FormGroup>

            <FormGroup label={t('deploy.fields.engineArgs')} fieldId="engine-args">
              <TextArea
                id="engine-args"
                value={form.engineArgs}
                onChange={(_ev, val) => set('engineArgs', val)}
                aria-invalid={submitted && !!errors.engineArgs}
                aria-describedby="engine-args-helper"
                placeholder={t('deploy.fields.engineArgsPlaceholder')}
                rows={5}
                style={{ fontFamily: 'monospace' }}
              />
              <FieldHelper
                hint={t('deploy.hints.engineArgs')}
                error={errors.engineArgs}
                showError={submitted}
                fieldId="engine-args"
              />
            </FormGroup>

            <ActionGroup>
              <Button
                variant="primary"
                type="submit"
                isLoading={deployModel.isPending}
                isDisabled={deployModel.isPending}
              >
                {t('deploy.button')}
              </Button>
              <Button variant="link" onClick={() => void navigate('/models')}>
                {tCommon('actions.cancel')}
              </Button>
            </ActionGroup>
          </Form>
        </CardBody>
      </Card>

      <WeightsBrowserModal
        isOpen={browseOpen}
        onClose={() => setBrowseOpen(false)}
        onSelect={(absolutePath) => set('modelPath', absolutePath)}
      />

      {logsModalModelName && (
        <DeployLogsModal
          modelName={logsModalModelName}
          isOpen={logsModalModelName !== null}
          onClose={closeLogsModal}
        />
      )}
    </PageSection>
  );
}
