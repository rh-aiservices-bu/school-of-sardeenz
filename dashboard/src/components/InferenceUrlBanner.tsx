import { Card, CardBody, ClipboardCopy, ClipboardCopyVariant, Grid, GridItem } from '@patternfly/react-core';
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
        <Grid hasGutter style={{ gap: 'var(--pf-t--global--spacer--sm)' }}>
          <GridItem span={2} style={{ alignSelf: 'center' }}>
            <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
              {t('overview.inferenceUrl.openai.label')}
            </span>
          </GridItem>
          <GridItem span={5} style={{ alignSelf: 'center' }}>
            <ClipboardCopy
              isReadOnly
              hoverTip={t('overview.inferenceUrl.copy')}
              clickTip={t('overview.inferenceUrl.copied')}
              variant={ClipboardCopyVariant.inline}
              aria-label={t('overview.inferenceUrl.openai.copyAria')}
              style={{ wordBreak: 'break-all' }}
            >
              {openaiUrl}
            </ClipboardCopy>
          </GridItem>
          <GridItem span={5} style={{ alignSelf: 'center' }}>
            <span
              style={{
                fontSize: 'var(--pf-t--global--font--size--sm)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('overview.inferenceUrl.openai.description')}
            </span>
          </GridItem>
          <GridItem span={2} style={{ alignSelf: 'center' }}>
            <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
              {t('overview.inferenceUrl.oip.label')}
            </span>
          </GridItem>
          <GridItem span={5} style={{ alignSelf: 'center' }}>
            <ClipboardCopy
              isReadOnly
              hoverTip={t('overview.inferenceUrl.copy')}
              clickTip={t('overview.inferenceUrl.copied')}
              variant={ClipboardCopyVariant.inline}
              aria-label={t('overview.inferenceUrl.oip.copyAria')}
              style={{ wordBreak: 'break-all' }}
            >
              {oipUrl}
            </ClipboardCopy>
          </GridItem>
          <GridItem span={5} style={{ alignSelf: 'center' }}>
            <span
              style={{
                fontSize: 'var(--pf-t--global--font--size--sm)',
                color: 'var(--pf-t--global--text--color--subtle)',
              }}
            >
              {t('overview.inferenceUrl.oip.description')}
            </span>
          </GridItem>
        </Grid>
      </CardBody>
    </Card>
  );
}
