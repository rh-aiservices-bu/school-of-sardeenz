import {
  Card,
  CardBody,
  ClipboardCopy,
  ClipboardCopyVariant,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { useConfig } from '../hooks/useConfig';
import { openaiBaseUrl } from '../utils/inference';

// Front-and-center, copyable inference base URL for the home view — sourced from the BFF's
// GET /api/config (never window.location.origin, which only works when the proxy shares the
// dashboard's ingress).
export function InferenceUrlBanner() {
  const { t } = useTranslation('cluster');
  const { data } = useConfig();

  if (!data?.inferenceUrl) return null;

  const base = openaiBaseUrl(data.inferenceUrl);

  return (
    <Card isCompact>
      <CardBody>
        <Flex
          alignItems={{ default: 'alignItemsCenter' }}
          spaceItems={{ default: 'spaceItemsSm' }}
          flexWrap={{ default: 'wrap' }}
        >
          <FlexItem>
            <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
              {t('overview.inferenceUrl.label')}
            </span>
          </FlexItem>
          <FlexItem>
            <ClipboardCopy
              isReadOnly
              hoverTip={t('overview.inferenceUrl.copy')}
              clickTip={t('overview.inferenceUrl.copied')}
              variant={ClipboardCopyVariant.inline}
              aria-label={t('overview.inferenceUrl.copyAria')}
            >
              {base}
            </ClipboardCopy>
          </FlexItem>
          <FlexItem>
            <span
              style={{
                fontSize: 'var(--pf-t--global--font--size--sm)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('overview.inferenceUrl.description')}
            </span>
          </FlexItem>
        </Flex>
      </CardBody>
    </Card>
  );
}
