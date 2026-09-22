import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

// ---------------------------------------------------------------------------
// Types describing the shape of the "Questions" fixedCollection once it has
// been read off the node parameters, and the shape of Jev's API responses.
// ---------------------------------------------------------------------------

type QuestionKind = 'choice' | 'score' | 'noul';

interface QuestionEntry {
	questionId: string;
	type: QuestionKind;
	instructions: string;
	choiceCriteria?: { option?: Array<{ name: string; description: string }> };
	scoreLevels?: { level?: Array<{ label: string }> };
	noulTrueDescription?: string;
	noulFalseDescription?: string;
	confidenceThreshold?: number;
}

interface JevChoiceAnswer {
	type: 'choice';
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

interface JevScoreAnswer {
	type: 'score';
	score: number;
}

interface JevNoulAnswer {
	type: 'noul';
	noul: number;
}

type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

interface JevResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage?: { input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------
// Dynamic outputs. n8n evaluates this function (via its stringified source,
// see the `outputs` expression below) against the node's current parameters
// to decide how many output branches to render — the same mechanism the
// built-in Switch node uses. Because it only ever runs as re-parsed source
// text, it must not reference anything outside its own body.
// ---------------------------------------------------------------------------

function configuredOutputs(parameters: IDataObject) {
	const operation = parameters.operation as string;
	if (operation !== 'classifyRoute') {
		return [{ type: 'main', displayName: 'Output' }];
	}

	const routingQuestionId = parameters.routingQuestion as string;
	if (!routingQuestionId) {
		return [{ type: 'main', displayName: 'Output' }];
	}

	const questionsParam = parameters.questions as
		| { question?: Array<Record<string, unknown>> }
		| undefined;
	const questionList = questionsParam?.question ?? [];
	const routingQuestion = questionList.find(
		(q) => q.questionId === routingQuestionId,
	) as Record<string, unknown> | undefined;

	// Routing only makes sense for Choice questions — anything else falls
	// back to a single output.
	if (!routingQuestion || routingQuestion.type !== 'choice') {
		return [{ type: 'main', displayName: 'Output' }];
	}

	const choiceCriteria = routingQuestion.choiceCriteria as
		| { option?: Array<{ name: string }> }
		| undefined;
	const options = choiceCriteria?.option ?? [];

	const outputs = options.map((option) => ({
		type: 'main',
		displayName: option.name || 'Unnamed Option',
	}));
	outputs.push({ type: 'main', displayName: 'Needs Review' });

	return outputs;
}

export class JevRouter implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jev Router',
		name: 'jevRouter',
		icon: 'file:jevRouter.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			"Classify, score, and route items using TypeSafe AI's Jev structured-decision model",
		// Retry/backoff for transient errors (429 rate limit, 529 overloaded) is
		// n8n's standard per-node "Retry On Fail" setting (Settings tab on the
		// node), not something a node type can force on from its description —
		// it retries any thrown NodeApiError, which is what callJev() throws.
		defaults: {
			name: 'Jev Router',
		},
		inputs: ['main'],
		// The output count/labels for this node are resolved dynamically by n8n
		// at runtime (see `configuredOutputs` above), the same mechanism the
		// built-in Switch node uses, so this is an expression string rather
		// than a static array.
		outputs: `={{(${configuredOutputs.toString()})($parameter)}}` as unknown as INodeTypeDescription['outputs'],
		usableAsTool: true,
		credentials: [
			{
				name: 'jevApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Classify & Route',
						value: 'classifyRoute',
						description: 'Evaluate each item with Jev and optionally route it by the answer',
						action: 'Classify and route items',
					},
					{
						name: 'Calibration Check',
						value: 'calibrationCheck',
						description: "Compare Jev's answers against your own labeled data to pick a real confidence threshold",
						action: 'Check calibration against labeled data',
					},
				],
				default: 'classifyRoute',
			},

			// ---------------------------------------------------------------
			// Classify & Route fields
			// ---------------------------------------------------------------
			{
				displayName: 'State',
				name: 'state',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['classifyRoute'] } },
				description: 'The text or data Jev should evaluate. Supports expressions, e.g. {{$json.ticketBody}}.',
			},

			// ---------------------------------------------------------------
			// Calibration Check fields
			// ---------------------------------------------------------------
			{
				displayName: 'State Field Name',
				name: 'stateField',
				type: 'string',
				default: 'state',
				required: true,
				displayOptions: { show: { operation: ['calibrationCheck'] } },
				description: 'Name of the field on each input item that holds the text/data to evaluate',
			},
			{
				displayName: 'Ground Truth Field Name',
				name: 'groundTruthField',
				type: 'string',
				default: 'actual_department',
				required: true,
				displayOptions: { show: { operation: ['calibrationCheck'] } },
				description: 'Name of the field on each input item that holds the known-correct answer',
			},

			// ---------------------------------------------------------------
			// Questions (shared by both operations)
			// ---------------------------------------------------------------
			{
				displayName: 'Questions',
				name: 'questions',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Question',
				default: {},
				required: true,
				options: [
					{
						name: 'question',
						displayName: 'Question',
						values: [
							{
								displayName: 'Question ID',
								name: 'questionId',
								type: 'string',
								default: '',
								required: true,
								description: 'Key used to identify this question in the request and in the output, e.g. "department"',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{ name: 'Choice', value: 'choice' },
									{ name: 'Score', value: 'score' },
									{ name: 'Noul (Boolean)', value: 'noul' },
								],
								default: 'choice',
							},
							{
								displayName: 'Instructions',
								name: 'instructions',
								type: 'string',
								typeOptions: { rows: 2 },
								default: '',
								required: true,
								description: 'What Jev should judge, e.g. "Which department should handle this ticket?"',
							},
							{
								displayName: 'Choice Options',
								name: 'choiceCriteria',
								type: 'fixedCollection',
								typeOptions: { multipleValues: true },
								placeholder: 'Add Option',
								default: {},
								displayOptions: { show: { type: ['choice'] } },
								description: 'The possible choices Jev can pick between',
								options: [
									{
										name: 'option',
										displayName: 'Option',
										values: [
											{
												displayName: 'Option Name',
												name: 'name',
												type: 'string',
												default: '',
												required: true,
											},
											{
												displayName: 'Description',
												name: 'description',
												type: 'string',
												default: '',
											},
										],
									},
								],
							},
							{
								displayName: 'Score Levels',
								name: 'scoreLevels',
								type: 'fixedCollection',
								typeOptions: { multipleValues: true, sortable: true },
								placeholder: 'Add Level',
								default: {},
								displayOptions: { show: { type: ['score'] } },
								description: 'Ordered list of level labels, lowest to highest, e.g. Low / Medium / High / Critical',
								options: [
									{
										name: 'level',
										displayName: 'Level',
										values: [
											{
												displayName: 'Label',
												name: 'label',
												type: 'string',
												default: '',
												required: true,
											},
										],
									},
								],
							},
							{
								displayName: 'True Description',
								name: 'noulTrueDescription',
								type: 'string',
								default: '',
								displayOptions: { show: { type: ['noul'] } },
								description: 'Optional description of what "true" means for this question',
							},
							{
								displayName: 'False Description',
								name: 'noulFalseDescription',
								type: 'string',
								default: '',
								displayOptions: { show: { type: ['noul'] } },
								description: 'Optional description of what "false" means for this question',
							},
							{
								displayName: 'Confidence Threshold',
								name: 'confidenceThreshold',
								type: 'number',
								typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
								default: 0.5,
								// Noul answers have no confidence field (only a probability), so
								// this threshold is meaningless for them — hide it.
								displayOptions: { hide: { type: ['noul'] } },
								description: 'Answers below this confidence route to "Needs Review" when this is the routing question',
							},
						],
					},
				],
			},

			// ---------------------------------------------------------------
			// Routing (Classify & Route only)
			// ---------------------------------------------------------------
			{
				displayName: 'Routing Question',
				name: 'routingQuestion',
				type: 'options',
				default: '',
				displayOptions: { show: { operation: ['classifyRoute'] } },
				typeOptions: {
					loadOptionsMethod: 'getChoiceQuestionIds',
					// Without this, the editor only fetches this dropdown's options once
					// (while "questions" is still empty) and never refreshes them as
					// questions are added — it needs an explicit dependency to know to
					// re-fetch when that parameter changes.
					loadOptionsDependsOn: ['questions'],
				},
				description: 'Which Choice question decides the output branch. Leave blank to output everything on one branch.',
			},

			// ---------------------------------------------------------------
			// Comparison question (Calibration Check only)
			// ---------------------------------------------------------------
			{
				displayName: 'Question to Compare',
				name: 'comparisonQuestion',
				type: 'options',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['calibrationCheck'] } },
				typeOptions: {
					loadOptionsMethod: 'getAllQuestionIds',
					loadOptionsDependsOn: ['questions'],
				},
				description: "Which question's answer to compare against the ground-truth field",
			},
		],
	};

	methods = {
		loadOptions: {
			async getChoiceQuestionIds(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const questions = getQuestionEntries(this.getCurrentNodeParameter('questions') as IDataObject);
				const results: INodePropertyOptions[] = [{ name: '(No Routing)', value: '' }];
				for (const q of questions) {
					if (q.type === 'choice' && q.questionId) {
						results.push({ name: q.questionId, value: q.questionId });
					}
				}
				return results;
			},

			async getAllQuestionIds(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const questions = getQuestionEntries(this.getCurrentNodeParameter('questions') as IDataObject);
				return questions
					.filter((q) => q.questionId)
					.map((q) => ({ name: `${q.questionId} (${q.type})`, value: q.questionId }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;

		if (operation === 'calibrationCheck') {
			return [await runCalibrationCheck(this, items)];
		}

		return runClassifyRoute(this, items);
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Reads the raw `questions` fixedCollection parameter into a flat, typed array. */
function getQuestionEntries(questionsParam: IDataObject): QuestionEntry[] {
	const raw = (questionsParam?.question as QuestionEntry[] | undefined) ?? [];
	return raw;
}

/** Builds the `questions` object Jev's API expects from the parsed question entries. */
function buildQuestionsPayload(ctx: IExecuteFunctions, questions: QuestionEntry[]): IDataObject {
	const payload: IDataObject = {};

	for (const q of questions) {
		if (!q.questionId) {
			throw new NodeOperationError(ctx.getNode(), 'Every question needs a Question ID');
		}

		if (q.type === 'choice') {
			const options = q.choiceCriteria?.option ?? [];
			if (options.length === 0) {
				throw new NodeOperationError(
					ctx.getNode(),
					`Question "${q.questionId}" is a Choice question but has no Choice Options configured`,
				);
			}
			const criteria: IDataObject = {};
			for (const opt of options) {
				criteria[opt.name] = opt.description || opt.name;
			}
			payload[q.questionId] = {
				type: 'choice',
				instructions: q.instructions,
				criteria,
			};
		} else if (q.type === 'score') {
			const levels = q.scoreLevels?.level ?? [];
			if (levels.length === 0) {
				throw new NodeOperationError(
					ctx.getNode(),
					`Question "${q.questionId}" is a Score question but has no Score Levels configured`,
				);
			}
			payload[q.questionId] = {
				type: 'score',
				instructions: q.instructions,
				criteria: levels.map((l) => l.label),
			};
		} else {
			// noul
			const criteria: IDataObject = {};
			if (q.noulTrueDescription) criteria.true = q.noulTrueDescription;
			if (q.noulFalseDescription) criteria.false = q.noulFalseDescription;
			payload[q.questionId] = {
				type: 'noul',
				instructions: q.instructions,
				...(Object.keys(criteria).length ? { criteria } : {}),
			};
		}
	}

	return payload;
}

/** Flattens Jev's answers into flat, easy-to-reference output fields. */
function flattenAnswers(answers: Record<string, JevAnswer>): IDataObject {
	const flat: IDataObject = {};

	for (const [questionId, answer] of Object.entries(answers)) {
		if (answer.type === 'choice') {
			flat[`${questionId}_choice`] = answer.choice;
			flat[`${questionId}_confidence`] = answer.confidence;
			flat[`${questionId}_probabilities`] = answer.probabilities;
		} else if (answer.type === 'score') {
			flat[`${questionId}_score`] = answer.score;
		} else {
			flat[`${questionId}_noul`] = answer.noul;
		}
	}

	return flat;
}

// Jev-side transient failures worth retrying automatically: 429 (rate limited)
// and 529 (overloaded). Anything else fails immediately.
const RETRYABLE_STATUS_CODES = new Set([429, 529]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1000;

function getHttpStatus(error: unknown): number | undefined {
	const err = error as { response?: { status?: number }; httpCode?: string | number; statusCode?: number };
	const raw = err.response?.status ?? err.httpCode ?? err.statusCode;
	return raw === undefined ? undefined : Number(raw);
}

const wait = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls the Jev /v1/systemone endpoint once with a full batch of questions.
 * Retries transient 429/rate-limit and 529/overloaded responses with
 * exponential backoff on its own — this doesn't rely on the user having
 * enabled n8n's per-node "Retry On Fail" canvas setting, since a node type
 * can't turn that setting on by default from its description.
 */
async function callJev(
	ctx: IExecuteFunctions,
	state: unknown,
	questionsPayload: IDataObject,
	itemIndex: number,
): Promise<JevResponse> {
	const credentials = await ctx.getCredentials('jevApi');

	if (!credentials.apiKey) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Jev API credential is missing an API Key. Open the credential and add your TypeSafe AI API key.',
			{ itemIndex },
		);
	}

	const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'jevApi', {
				method: 'POST',
				url: `${baseUrl}/v1/systemone`,
				body: {
					model: 'jev-1.13.0',
					state,
					questions: questionsPayload,
				},
				json: true,
			});
			return response as JevResponse;
		} catch (error) {
			const status = getHttpStatus(error);
			const isRetryable = status !== undefined && RETRYABLE_STATUS_CODES.has(status);

			if (isRetryable && attempt < MAX_ATTEMPTS) {
				await wait(BASE_BACKOFF_MS * 2 ** (attempt - 1));
				continue;
			}

			if (status === 401 || status === 403) {
				throw new NodeApiError(ctx.getNode(), error as JsonObject, {
					itemIndex,
					message: 'Jev API rejected the request — check that the API Key in the Jev API credential is correct',
				});
			}

			throw new NodeApiError(ctx.getNode(), error as JsonObject, { itemIndex });
		}
	}

	// Unreachable: the loop above always returns or throws.
	throw new NodeOperationError(ctx.getNode(), 'Jev API call failed after retrying', { itemIndex });
}

// ---------------------------------------------------------------------------
// Operation 1: Classify & Route
// ---------------------------------------------------------------------------

async function runClassifyRoute(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[][]> {
	const routingQuestionId = ctx.getNodeParameter('routingQuestion', 0, '') as string;

	// Work out how many output branches exist and what they map to, mirroring
	// the same logic `configuredOutputs` used to draw them on the canvas.
	const questions = getQuestionEntries(ctx.getNodeParameter('questions', 0) as IDataObject);
	const routingQuestion = questions.find((q) => q.questionId === routingQuestionId);
	const isRouting = Boolean(routingQuestion && routingQuestion.type === 'choice');

	let optionNames: string[] = [];
	let needsReviewIndex = 0;
	if (isRouting) {
		optionNames = (routingQuestion!.choiceCriteria?.option ?? []).map((o) => o.name);
		needsReviewIndex = optionNames.length; // "Needs Review" is always the last output
	}

	const outputCount = isRouting ? optionNames.length + 1 : 1;
	const outputs: INodeExecutionData[][] = Array.from({ length: outputCount }, () => []);

	for (let i = 0; i < items.length; i++) {
		try {
			const state = ctx.getNodeParameter('state', i) as string;
			const itemQuestions = getQuestionEntries(ctx.getNodeParameter('questions', i) as IDataObject);
			const questionsPayload = buildQuestionsPayload(ctx, itemQuestions);

			const response = await callJev(ctx, state, questionsPayload, i);
			const flat = flattenAnswers(response.answers);

			const newItem: INodeExecutionData = {
				json: {
					...items[i].json,
					...flat,
					jevUsage: response.usage ?? {},
				},
				pairedItem: { item: i },
			};

			if (!isRouting) {
				outputs[0].push(newItem);
				continue;
			}

			const answer = response.answers[routingQuestionId] as JevChoiceAnswer | undefined;
			const threshold = routingQuestion!.confidenceThreshold ?? 0.5;

			let targetIndex = needsReviewIndex; // default to Needs Review
			if (answer && answer.confidence >= threshold) {
				const matchIndex = optionNames.indexOf(answer.choice);
				if (matchIndex !== -1) {
					targetIndex = matchIndex;
				}
			}

			outputs[targetIndex].push(newItem);
		} catch (error) {
			if (ctx.continueOnFail()) {
				outputs[0].push({
					json: { ...items[i].json, error: (error as Error).message },
					pairedItem: { item: i },
				});
				continue;
			}
			throw error;
		}
	}

	return outputs;
}

// ---------------------------------------------------------------------------
// Operation 2: Calibration Check
// ---------------------------------------------------------------------------

interface BucketStats {
	range: string;
	min: number;
	max: number;
	total: number;
	correct: number;
}

function makeBuckets(): BucketStats[] {
	const edges = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0];
	const buckets: BucketStats[] = [];
	for (let i = 0; i < edges.length - 1; i++) {
		const max = edges[i];
		const min = edges[i + 1];
		buckets.push({ range: `${min.toFixed(2)}-${max.toFixed(2)}`, min, max, total: 0, correct: 0 });
	}
	return buckets;
}

function bucketFor(buckets: BucketStats[], confidence: number): BucketStats {
	for (const bucket of buckets) {
		// Top bucket is inclusive on both ends; the rest are (min, max].
		if (confidence > bucket.min || (bucket.min === 0 && confidence >= 0)) {
			if (confidence <= bucket.max) return bucket;
		}
	}
	return buckets[buckets.length - 1];
}

async function runCalibrationCheck(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const comparisonQuestionId = ctx.getNodeParameter('comparisonQuestion', 0) as string;
	const buckets = makeBuckets();
	let total = 0;
	let totalCorrect = 0;

	// Jev's `state` is a single value per request, and each item here carries
	// its own state + ground truth, so — unlike Classify & Route — this mode
	// calls the API once per item rather than batching items together.
	for (let i = 0; i < items.length; i++) {
		const stateField = ctx.getNodeParameter('stateField', i) as string;
		const groundTruthField = ctx.getNodeParameter('groundTruthField', i) as string;
		const questions = getQuestionEntries(ctx.getNodeParameter('questions', i) as IDataObject);
		const questionsPayload = buildQuestionsPayload(ctx, questions);

		const state = items[i].json[stateField];
		const groundTruth = items[i].json[groundTruthField];

		if (state === undefined) {
			throw new NodeOperationError(
				ctx.getNode(),
				`Item ${i} has no field named "${stateField}" to use as state`,
				{ itemIndex: i },
			);
		}

		const response = await callJev(ctx, state, questionsPayload, i);
		const answer = response.answers[comparisonQuestionId];
		if (!answer) continue;

		let predicted: unknown;
		let confidence: number | undefined;

		if (answer.type === 'choice') {
			predicted = answer.choice;
			confidence = answer.confidence;
		} else if (answer.type === 'score') {
			predicted = answer.score;
			confidence = undefined; // Score answers carry no confidence value.
		} else {
			predicted = answer.noul >= 0.5;
			confidence = answer.noul; // Threshold on the noul probability itself.
		}

		if (confidence === undefined) continue; // Nothing to bucket without a confidence-like value.

		const isCorrect = String(predicted) === String(groundTruth);
		const bucket = bucketFor(buckets, confidence);
		bucket.total += 1;
		total += 1;
		if (isCorrect) {
			bucket.correct += 1;
			totalCorrect += 1;
		}
	}

	const bucketResults = buckets.map((b) => ({
		confidenceRange: b.range,
		count: b.total,
		accuracy: b.total > 0 ? Number(((b.correct / b.total) * 100).toFixed(1)) : null,
	}));

	return [
		{
			json: {
				buckets: bucketResults,
				totalExamples: total,
				overallAccuracy: total > 0 ? Number(((totalCorrect / total) * 100).toFixed(1)) : null,
			},
		},
	];
}
