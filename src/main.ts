import * as core from '@actions/core'
import * as github from '@actions/github'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true })
    const pr = github.context.payload.pull_request
    if (!pr) {
      throw new Error(
        'event context does not contain pull request data - ensure this action was triggered on a `pull_request` event'
      )
    }
    const octokit = github.getOctokit(token)
    const approvals = await getPullRequestApprovals({
      octokit,
      prNumber: pr.number
    })

    const excludingShasInput = core.getInput('excluding-shas')
    const excludingShas = excludingShasInput
      ? excludingShasInput.split(',').map(sha => sha.trim())
      : []

    const approvalsToProcess =
      excludingShas.length > 0
        ? approvals.filter(
            approval =>
              approval.commit_id === null ||
              !excludingShas.includes(approval.commit_id)
          )
        : approvals

    await dismissApprovals({
      approvalIds: approvalsToProcess.map(approval => approval.id),
      octokit,
      prNumber: pr.number,
      reason: core.getInput('reason', { required: true })
    })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Not Found')) {
        console.warn('Did you set the correct permissions?')
      }
      core.setFailed(error.message)
    }
  }
}

type Octokit = ReturnType<typeof github.getOctokit>

async function getPullRequestApprovals({
  octokit,
  prNumber
}: {
  octokit: Octokit
  prNumber: number
}): Promise<
  {
    id: number
    commit_id: string | null
  }[]
> {
  const approvals: {
    id: number
    commit_id: string | null
  }[] = []

  for (let page = 1; ; ++page) {
    const result = await octokit.rest.pulls.listReviews({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
      page: page
    })
    approvals.push(...result.data.filter(review => review.state === 'APPROVED'))
    if (!result.headers.link || !result.headers.link.includes('rel="next"')) {
      break
    }
  }

  return approvals
}

async function dismissApprovals({
  approvalIds,
  octokit,
  prNumber,
  reason
}: {
  approvalIds: number[]
  octokit: Octokit
  prNumber: number
  reason: string
}): Promise<void> {
  if (approvalIds.length === 0) {
    return
  }

  if (core.getBooleanInput('dry-run')) {
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      body: `dismiss_stale_approvals dry run: Would have dismissed ${approvalIds.length} approvals with reason:\n\n${reason}`
    })
    return
  }

  await Promise.all(
    approvalIds.map(async approvalId =>
      octokit.rest.pulls.dismissReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: prNumber,
        review_id: approvalId,
        message: reason
      })
    )
  )
}
