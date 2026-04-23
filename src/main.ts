import {context} from '@actions/github';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import axios, {isAxiosError} from 'axios';
import {Inputs} from './interfaces';
import {showInputs, getInputs} from './get-inputs';
import {setTokens} from './set-tokens';
import {setRepo, setCommitAuthor, getCommitMessage, commit, push, pushTag} from './git-utils';
import {getWorkDirName, addNoJekyll, addCNAME, skipOnFork} from './utils';

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = 'peaceiris/actions-gh-pages';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('[1;36mStepSecurity Maintained Action[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('[32m✓ Free for public repositories[0m');
  core.info(`[36mLearn more:[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = {action: action || ''};
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(`[1;31mThis action requires a StepSecurity subscription for private repositories.[0m`);
      core.error(`[31mLearn how to enable a subscription: ${docsUrl}[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

export async function run(): Promise<void> {
  try {
    await validateSubscription();

    core.info('[INFO] Usage https://github.com/step-security/actions-gh-pages#readme');

    const inps: Inputs = getInputs();
    core.startGroup('Dump inputs');
    showInputs(inps);
    core.endGroup();

    if (core.isDebug()) {
      core.startGroup('Debug: dump context');
      console.log(context);
      core.endGroup();
    }

    const eventName = context.eventName;
    if (eventName === 'pull_request' || eventName === 'push') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isForkRepository = (context.payload as any).repository.fork;
      const isSkipOnFork = await skipOnFork(
        isForkRepository,
        inps.GithubToken,
        inps.DeployKey,
        inps.PersonalToken
      );
      if (isSkipOnFork) {
        core.warning('This action runs on a fork and not found auth token, Skip deployment');
        core.setOutput('skip', 'true');
        return;
      }
    }

    core.startGroup('Setup auth token');
    const remoteURL = await setTokens(inps);
    core.debug(`remoteURL: ${remoteURL}`);
    core.endGroup();

    core.startGroup('Prepare publishing assets');
    const date = new Date();
    const unixTime = date.getTime();
    const workDir = await getWorkDirName(`${unixTime}`);
    await setRepo(inps, remoteURL, workDir);
    await addNoJekyll(workDir, inps.DisableNoJekyll);
    await addCNAME(workDir, inps.CNAME);
    core.endGroup();

    core.startGroup('Setup Git config');
    try {
      await exec.exec('git', ['remote', 'rm', 'origin']);
    } catch (error) {
      if (error instanceof Error) {
        core.info(`[INFO] ${error.message}`);
      } else {
        throw new Error('unexpected error');
      }
    }
    await exec.exec('git', ['remote', 'add', 'origin', remoteURL]);
    await exec.exec('git', ['add', '--all']);
    await setCommitAuthor(inps.UserName, inps.UserEmail);
    core.endGroup();

    core.startGroup('Create a commit');
    const hash = `${process.env.GITHUB_SHA}`;
    const baseRepo = `${github.context.repo.owner}/${github.context.repo.repo}`;
    const commitMessage = getCommitMessage(
      inps.CommitMessage,
      inps.FullCommitMessage,
      inps.ExternalRepository,
      baseRepo,
      hash
    );
    await commit(inps.AllowEmptyCommit, commitMessage);
    core.endGroup();

    core.startGroup('Push the commit or tag');
    await push(inps.PublishBranch, inps.ForceOrphan);
    await pushTag(inps.TagName, inps.TagMessage);
    core.endGroup();

    core.info('[INFO] Action successfully completed');

    return;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(error.message);
    } else {
      throw new Error('unexpected error');
    }
  }
}
