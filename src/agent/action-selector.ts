import type { Action } from '../domain/action.js';
import {
  asActionId,
  asDecisionId,
  asMemoryRecordId,
  type Clock,
  type IdGenerator,
} from '../domain/ids.js';
import { mergeProvenance, type RunCorrelation } from '../domain/provenance.js';
import type { DecisionOption, DecisionRecord, EvidenceReference } from '../memory/records.js';
import type { ModelProvider, ToolActionProposal } from '../models/contracts.js';
import type { ActionSelection, ActionSelectionInput, ActionSelector } from './contracts.js';
import {
  presentedMemory,
  renderAttempts,
  renderGoal,
  renderMemory,
  renderPlan,
  type PresentedMemory,
} from './prompting.js';

/**
 * Asks the model which tool to use next for the current task and turns the
 * proposal into an Action plus a DecisionRecord. The model proposes; nothing
 * here executes anything.
 */
export class ModelActionSelector implements ActionSelector {
  constructor(
    private readonly model: ModelProvider,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async selectNext(input: ActionSelectionInput): Promise<ActionSelection> {
    const memory = presentedMemory(input.retrievals);
    const response = await this.model.requestToolAction({
      purpose: 'select_action',
      messages: [
        {
          role: 'system',
          content:
            'You are the action-selection component of an autonomous agent. Choose exactly one tool call that makes progress on the CURRENT TASK, or finish if the goal is demonstrably complete, or give up if no useful continuation exists. Do not repeat an approach that already failed unless you change something material.',
        },
        {
          role: 'user',
          content: [
            renderGoal(input.goal),
            renderPlan(input.plan),
            `CURRENT TASK: [${input.task.taskId}] ${input.task.description}\nEXPECTED EVIDENCE: ${input.task.expectedEvidence.join('; ')}`,
            renderAttempts(input.previousAttempts),
            renderMemory(memory),
          ].join('\n\n'),
        },
      ],
      tools: input.availableTools,
    });

    const proposal = response.proposal;
    switch (proposal.kind) {
      case 'finish':
        return { kind: 'finish', summary: proposal.summary };
      case 'give_up':
        return { kind: 'give_up', reason: proposal.reason };
      case 'tool':
        return this.toAction(input, proposal, memory);
    }
  }

  private toAction(
    input: ActionSelectionInput,
    proposal: Extract<ToolActionProposal, { kind: 'tool' }>,
    memory: PresentedMemory,
  ): ActionSelection {
    const now = this.clock.now();
    const correlation: RunCorrelation = {
      runId: input.goal.runId,
      goalId: input.goal.goalId,
      taskId: input.task.taskId,
    };
    const previous = input.previousAttempts.at(-1);
    const actionId = asActionId(this.ids.next('act'));
    const decisionId = asDecisionId(this.ids.next('dec'));

    const options: DecisionOption[] = [
      {
        optionId: 'selected',
        description: `${proposal.toolName}: ${proposal.rationale}`,
        assessment: 'selected',
      },
      ...(proposal.alternatives ?? []).map((alt, index) => ({
        optionId: `alternative-${index + 1}`,
        description: alt.description,
        assessment: alt.whyNot,
      })),
    ];

    const evidence: EvidenceReference[] = [
      ...memory.records.map((r) => ({
        description: `${r.kind}: ${r.summary}`,
        memoryRecordId: asMemoryRecordId(r.recordId),
      })),
      ...input.previousAttempts.map((a) => ({
        description: `attempt ${a.action.attempt} evaluated ${a.evaluation.verdict}`,
        observationId: a.observation.observationId,
      })),
    ];

    const decision: DecisionRecord = {
      recordId: asMemoryRecordId(this.ids.next('mem')),
      kind: 'decision',
      decisionId,
      runId: input.goal.runId,
      goalId: input.goal.goalId,
      taskId: input.task.taskId,
      createdAt: now,
      summary: `Use ${proposal.toolName} for task ${input.task.taskId}`,
      tags: [proposal.toolName, 'action-selection'],
      provenance: mergeProvenance(
        { planIds: [input.plan.planId] },
        memory.retrievalIds.length > 0 ? { retrievalIds: memory.retrievalIds } : {},
        memory.records.length > 0 ? { memoryRecordIds: memory.records.map((r) => r.recordId) } : {},
        input.previousAttempts.length > 0
          ? {
              actionIds: input.previousAttempts.map((a) => a.action.actionId),
              evaluationIds: input.previousAttempts.map((a) => a.evaluation.evaluationId),
            }
          : {},
      ),
      context: input.task.description,
      optionsConsidered: options,
      selectedOptionId: 'selected',
      evidence,
      reason: proposal.rationale,
      actionId,
      outcome: 'pending',
      lessonIds: [],
      ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
    };

    const action: Action = {
      actionId,
      correlation,
      planId: input.plan.planId,
      decisionId,
      toolName: proposal.toolName,
      input: proposal.input,
      attempt: input.previousAttempts.length + 1,
      intent: proposal.rationale,
      derivedFrom: { planIds: [input.plan.planId], decisionIds: [decisionId] },
      requestedAt: now,
      ...(previous ? { retryOf: previous.action.actionId } : {}),
    };

    return { kind: 'act', action, decision };
  }
}
