import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '../slices/github-slice-test-harness'
import { projectViewCacheKey } from './cache-identity'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import type { GitHubProjectMutationResult } from '../../../../shared/github/project-result-types'

const key = projectViewCacheKey('user', 'owner', 1, 'view')
const failed: GitHubProjectMutationResult = {
  ok: false,
  error: { type: 'network_error', message: 'Offline' }
}

function fixture(): GitHubProjectTable {
  return {
    project: {
      id: 'project',
      owner: 'owner',
      ownerType: 'user',
      number: 1,
      title: 'Test',
      url: ''
    },
    selectedView: {
      id: 'view',
      number: 1,
      name: 'Board',
      layout: 'BOARD_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [],
      sortByFields: [],
      verticalGroupByFields: [
        {
          id: 'status',
          name: 'Status',
          kind: 'single-select',
          dataType: 'SINGLE_SELECT',
          options: [
            { id: 'todo', name: 'Todo', color: 'GREEN' },
            { id: 'done', name: 'Done', color: 'PURPLE' }
          ]
        }
      ]
    },
    rows: [
      {
        id: 'row',
        itemType: 'ISSUE',
        updatedAt: '',
        position: 0,
        content: {
          title: 'Original',
          number: 1,
          body: null,
          url: '',
          state: 'OPEN',
          stateReason: null,
          isDraft: null,
          repository: 'owner/repo',
          assignees: [],
          labels: [],
          parentIssue: null,
          issueType: null
        },
        fieldValuesByFieldId: {
          status: {
            kind: 'single-select',
            fieldId: 'status',
            optionId: 'todo',
            name: 'Todo',
            color: 'GREEN'
          }
        }
      }
    ],
    totalCount: 1,
    parentFieldDropped: false
  }
}

function setup() {
  const store = createTestStore()
  store.setState({ projectViewCache: { [key]: { data: fixture(), fetchedAt: 1 } } })
  return store
}

function deferred() {
  let resolve: (result: GitHubProjectMutationResult) => void = () => {
    throw new Error('Not initialized')
  }
  const promise = new Promise<GitHubProjectMutationResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const field = (store: ReturnType<typeof setup>) =>
  store.getState().projectViewCache[key]?.data?.rows[0]?.fieldValuesByFieldId.status

beforeEach(() => {
  vi.resetAllMocks()
  resetRemoteRuntimeMocks()
})

describe('project field writes', () => {
  it('keeps rapid moves optimistic and sends update then clear in order', async () => {
    const store = setup()
    const first = deferred()
    mockApi.gh.updateProjectItemField.mockReturnValueOnce(first.promise)
    mockApi.gh.clearProjectItemField.mockResolvedValueOnce({ ok: true })
    const update = store
      .getState()
      .updateProjectFieldValue(key, 'row', 'status', { kind: 'single-select', optionId: 'done' })
    expect(field(store)).toMatchObject({ optionId: 'done', name: 'Done', color: 'PURPLE' })
    const clear = store.getState().clearProjectFieldValue(key, 'row', 'status')
    expect(field(store)).toBeUndefined()
    await vi.waitFor(() => expect(mockApi.gh.updateProjectItemField).toHaveBeenCalledTimes(1))
    expect(mockApi.gh.clearProjectItemField).not.toHaveBeenCalled()
    first.resolve({ ok: true })
    await Promise.all([update, clear])
    expect(mockApi.gh.clearProjectItemField).toHaveBeenCalledTimes(1)
    expect(field(store)).toBeUndefined()
  })

  it.each([true, false])(
    'rolls a failed clear back to the last confirmed value (first succeeds: %s)',
    async (succeeds) => {
      const store = setup()
      const first = deferred()
      mockApi.gh.updateProjectItemField.mockReturnValueOnce(first.promise)
      mockApi.gh.clearProjectItemField.mockResolvedValueOnce(failed)
      const update = store
        .getState()
        .updateProjectFieldValue(key, 'row', 'status', { kind: 'single-select', optionId: 'done' })
      const clear = store.getState().clearProjectFieldValue(key, 'row', 'status')
      first.resolve(succeeds ? { ok: true } : failed)
      await Promise.all([update, clear])
      expect(field(store)).toMatchObject({ optionId: succeeds ? 'done' : 'todo' })
    }
  )

  it('does not roll back a newer clear when two clear requests overlap', async () => {
    const store = setup()
    const first = deferred()
    const second = deferred()
    mockApi.gh.clearProjectItemField
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const clear1 = store.getState().clearProjectFieldValue(key, 'row', 'status')
    const clear2 = store.getState().clearProjectFieldValue(key, 'row', 'status')
    first.resolve(failed)
    await clear1
    expect(field(store)).toBeUndefined()
    second.resolve({ ok: true })
    await clear2
    expect(field(store)).toBeUndefined()
  })

  it('preserves a concurrent content edit when a field transport throws', async () => {
    const store = setup()
    mockApi.gh.updateProjectItemField.mockRejectedValueOnce(new Error('Transport closed'))
    const request = store
      .getState()
      .updateProjectFieldValue(key, 'row', 'status', { kind: 'single-select', optionId: 'done' })
    store.getState().patchProjectRowContent(key, 'row', { title: 'Edited' })
    expect(await request).toMatchObject({ ok: false, error: { message: 'Transport closed' } })
    expect(field(store)).toMatchObject({ optionId: 'todo' })
    expect(store.getState().projectViewCache[key]?.data?.rows[0]?.content.title).toBe('Edited')
  })

  it('preserves an authoritative refresh instead of rolling back a failed clear', async () => {
    const store = setup()
    const response = deferred()
    mockApi.gh.clearProjectItemField.mockReturnValueOnce(response.promise)
    const request = store.getState().clearProjectFieldValue(key, 'row', 'status')
    const refreshed = fixture()
    delete refreshed.rows[0].fieldValuesByFieldId.status
    store.setState({ projectViewCache: { [key]: { data: refreshed, fetchedAt: 2 } } })
    response.resolve(failed)
    await request
    expect(field(store)).toBeUndefined()
  })
})
