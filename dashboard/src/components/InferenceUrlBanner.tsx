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
import { openaiBaseUrl, oipBaseUrl } from '../utils/inference';

// Front-and-center, copyable inference base URLs for the home view — sourced from the BFF's
// GET /api/config (never window.location.origin, which only works when the proxy shares the
// dashboard's ingress). Both protocol families are always mounted on the proxy (data-driven
// activation — ADR-021), so both rows are shown unconditionally, with no catalog dependency.
export function InferenceUrlBanner() {
  const { t } = useTranslation('cluster');
  const { data } = useConfig();

  if (!data?.inferenceUrl) return null;

  const openaiUrl = openaiBaseUrl(data.inferenceUrl);
  const oipUrl = oipBaseUrl(data.inferenceUrl);

  return (
    <Card isCompact>
      <CardBody>
        <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsSm' }}>
          <FlexItem>
            <Flex
              alignItems={{ default: 'alignItemsCenter' }}
              spaceItems={{ default: 'spaceItemsSm' }}
              flexWrap={{ default: 'wrap' }}
            >
              <FlexItem>
                <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                  {t('overview.inferenceUrl.openai.label')}
                </span>
              </FlexItem>
              <FlexItem>
                <ClipboardCopy
                  isReadOnly
                  hoverTip={t('overview.inferenceUrl.copy')}
                  clickTip={t('overview.inferenceUrl.copied')}
                  variant={ClipboardCopyVariant.inline}
                  aria-label={t('overview.inferenceUrl.openai.copyAria')}
                >
                  {openaiUrl}
                </ClipboardCopy>
              </FlexItem>
              <FlexItem>
                <span
                  style={{
                    fontSize: 'var(--pf-t--global--font--size--sm)',
                    color: 'var(--pf-t--global--text--color--subtle)',
                  }}
                >
                  {t('overview.inferenceUrl.openai.description')}
                </span>
              </FlexItem>
            </Flex>
          </FlexItem>
          <FlexItem>
            <Flex
              alignItems={{ default: 'alignItemsCenter' }}
              spaceItems={{ default: 'spaceItemsSm' }}
              flexWrap={{ default: 'wrap' }}
            >
              <FlexItem>
                <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
                  {t('overview.inferenceUrl.oip.label')}
                </span>
              </FlexItem>
              <FlexItem>
                <ClipboardCopy
                  isReadOnly
                  hoverTip={t('overview.inferenceUrl.copy')}
                  clickTip={t('overview.inferenceUrl.copied')}
                  variant={ClipboardCopyVariant.inline}
                  aria-label={t('overview.inferenceUrl.oip.copyAria')}
                >
                  {oipUrl}
                </ClipboardCopy>
              </FlexItem>
              <FlexItem>
                <span
                  style={{
                    fontSize: 'var(--pf-t--global--font--size--sm)',
                    color: 'var(--pf-t--global--text--color--subtle)',
                  }}
                >
                  {t('overview.inferenceUrl.oip.description')}
                </span>
              </FlexItem>
            </Flex>
          </FlexItem>
        </Flex>
      </CardBody>
    </Card>
  );
}
