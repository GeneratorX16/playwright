/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import { ansi2html } from '@web/ansi2html';
import * as React from 'react';
import './testErrorView.css';
import type { ImageDiff } from '@web/shared/imageDiffView';
import { ImageDiffView } from '@web/shared/imageDiffView';
import { TestAttachment } from './types';
import { fixTestInstructions } from '@web/prompts';

export const CodeSnippet = ({ code, children, testId }: React.PropsWithChildren<{ code: string; testId?: string; }>) => {
  const html = React.useMemo(() => ansiErrorToHtml(code), [code]);
  return (
    <div className='test-error-container test-error-text' data-testid={testId}>
      {children}
      <div className='test-error-view' dangerouslySetInnerHTML={{ __html: html || '' }}></div>
    </div>
  );
};

export const PromptButton: React.FC<{ context?: TestAttachment }> = ({ context }) => {
  const [copied, setCopied] = React.useState(false);
  return <button
    className='button'
    style={{ minWidth: 100 }}
    onClick={async () => {
      const contextText = context?.path ? await fetch(context.path!).then(r => r.text()) : context?.body;
      const prompt = fixTestInstructions + contextText; // TODO in next PR: enrich with test location, error details and source code.
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 3000);
    }}>
    {copied ? 'Copied' : 'Copy prompt'}
  </button>;
};

export const TestScreenshotErrorView: React.FC<{
  errorPrefix?: string,
  diff: ImageDiff,
  errorSuffix?: string,
}> = ({ errorPrefix, diff, errorSuffix }) => {
  const prefixHtml = React.useMemo(() => ansiErrorToHtml(errorPrefix), [errorPrefix]);
  const suffixHtml = React.useMemo(() => ansiErrorToHtml(errorSuffix), [errorSuffix]);
  return <div data-testid='test-screenshot-error-view' className='test-error-view'>
    <div dangerouslySetInnerHTML={{ __html: prefixHtml || '' }} className='test-error-text' style={{ marginBottom: 20 }}></div>
    <ImageDiffView key='image-diff' diff={diff} hideDetails={true}></ImageDiffView>
    <div data-testid='error-suffix' dangerouslySetInnerHTML={{ __html: suffixHtml || '' }} className='test-error-text'></div>
  </div>;
};

function ansiErrorToHtml(text?: string): string {
  const defaultColors = {
    bg: 'var(--color-canvas-subtle)',
    fg: 'var(--color-fg-default)',
  };
  return ansi2html(text || '', defaultColors);
}
