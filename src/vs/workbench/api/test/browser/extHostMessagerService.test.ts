/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MainThreadMessageService } from 'vs/workbench/api/browser/mainThreadMessageService';
import { IDialogService, IPrompt, IPromptButton } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService, INotification, NoOpNotification, INotificationHandle, Severity, IPromptChoice, IPromptOptions, IStatusMessageOptions, INotificationSource, INotificationSourceFilter, NotificationsFilter } from 'vs/platform/notification/common/notification';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { mock } from 'vs/base/test/common/mock';
import { IDisposable, Disposable } from 'vs/base/common/lifecycle';
import { Event } from 'vs/base/common/event';
import { TestDialogService } from 'vs/platform/dialogs/test/common/testDialogService';
import { ensureNoDisposablesAreLeakedInTestSuite } from 'vs/base/test/common/utils';
import { TestExtensionService } from 'vs/workbench/test/common/workbenchTestServices';

const emptyCommandService: ICommandService = {
	_serviceBrand: undefined,
	onWillExecuteCommand: () => Disposable.None,
	onDidExecuteCommand: () => Disposable.None,
	executeCommand: (commandId: string, ...args: any[]): Promise<any> => {
		return Promise.resolve(undefined);
	}
};

const emptyNotificationService = new class implements INotificationService {
	declare readonly _serviceBrand: undefined;
	onDidAddNotification: Event<INotification> = Event.None;
	onDidRemoveNotification: Event<INotification> = Event.None;
	onDidChangeFilter: Event<void> = Event.None;
	notify(...args: any[]): never {
		throw new Error('not implemented');
	}
	info(...args: any[]): never {
		throw new Error('not implemented');
	}
	warn(...args: any[]): never {
		throw new Error('not implemented');
	}
	error(...args: any[]): never {
		throw new Error('not implemented');
	}
	prompt(severity: Severity, message: string, choices: IPromptChoice[], options?: IPromptOptions): INotificationHandle {
		throw new Error('not implemented');
	}
	status(message: string | Error, options?: IStatusMessageOptions): IDisposable {
		return Disposable.None;
	}
	setFilter(): void {
		throw new Error('not implemented');
	}
	getFilter(source?: INotificationSource | undefined): NotificationsFilter {
		throw new Error('not implemented');
	}
	getFilters(): INotificationSourceFilter[] {
		throw new Error('not implemented');
	}
	removeFilter(sourceId: string): void {
		throw new Error('not implemented');
	}
};

class EmptyNotificationService implements INotificationService {
	declare readonly _serviceBrand: undefined;
	filter: boolean = false;
	constructor(private withNotify: (notification: INotification) => void) {
	}

	onDidAddNotification: Event<INotification> = Event.None;
	onDidRemoveNotification: Event<INotification> = Event.None;
	onDidChangeFilter: Event<void> = Event.None;
	notify(notification: INotification): INotificationHandle {
		this.withNotify(notification);

		return new NoOpNotification();
	}
	info(message: any): void {
		throw new Error('Method not implemented.');
	}
	warn(message: any): void {
		throw new Error('Method not implemented.');
	}
	error(message: any): void {
		throw new Error('Method not implemented.');
	}
	prompt(severity: Severity, message: string, choices: IPromptChoice[], options?: IPromptOptions): INotificationHandle {
		throw new Error('Method not implemented');
	}
	status(message: string, options?: IStatusMessageOptions): IDisposable {
		return Disposable.None;
	}
	setFilter(): void {
		throw new Error('Method not implemented.');
	}
	getFilter(source?: INotificationSource | undefined): NotificationsFilter {
		throw new Error('Method not implemented.');
	}
	getFilters(): INotificationSourceFilter[] {
		throw new Error('Method not implemented.');
	}
	removeFilter(sourceId: string): void {
		throw new Error('Method not implemented.');
	}
}

suite('ExtHostMessageService', function () {

	test('propagte handle on select', async function () {

		const service = new MainThreadMessageService(null!, new EmptyNotificationService(notification => {
			assert.strictEqual(notification.actions!.primary!.length, 1);
			queueMicrotask(() => notification.actions!.primary![0].run());
		}), emptyCommandService, new TestDialogService(), new TestExtensionService());

		const handle = await service.$showMessage(1, 'h', {}, [{ handle: 42, title: 'a thing', isCloseAffordance: true }]);
		assert.strictEqual(handle, 42);

		service.dispose();
	});

	suite('modal', () => {
		test('calls dialog service', async () => {
			const service = new MainThreadMessageService(null!, emptyNotificationService, emptyCommandService, new class extends mock<IDialogService>() {
				override prompt({ type, message, buttons, cancelButton }: IPrompt<any>) {
					assert.strictEqual(type, 1);
					assert.strictEqual(message, 'h');
					assert.strictEqual(buttons!.length, 1);
					assert.strictEqual((cancelButton as IPromptButton<unknown>)!.label, 'Cancel');
					return Promise.resolve({ result: buttons![0].run({ checkboxChecked: false }) });
				}
			} as IDialogService, new TestExtensionService());

			const handle = await service.$showMessage(1, 'h', { modal: true }, [{ handle: 42, title: 'a thing', isCloseAffordance: false }]);
			assert.strictEqual(handle, 42);

			service.dispose();
		});

		test('returns undefined when cancelled', async () => {
			const service = new MainThreadMessageService(null!, emptyNotificationService, emptyCommandService, new class extends mock<IDialogService>() {
				override prompt(prompt: IPrompt<any>) {
					return Promise.resolve({ result: (prompt.cancelButton as IPromptButton<unknown>)!.run({ checkboxChecked: false }) });
				}
			} as IDialogService, new TestExtensionService());

			const handle = await service.$showMessage(1, 'h', { modal: true }, [{ handle: 42, title: 'a thing', isCloseAffordance: false }]);
			assert.strictEqual(handle, undefined);

			service.dispose();
		});

		test('hides Cancel button when not needed', async () => {
			const service = new MainThreadMessageService(null!, emptyNotificationService, emptyCommandService, new class extends mock<IDialogService>() {
				override prompt({ type, message, buttons, cancelButton }: IPrompt<any>) {
					assert.strictEqual(buttons!.length, 0);
					assert.ok(cancelButton);
					return Promise.resolve({ result: (cancelButton as IPromptButton<unknown>).run({ checkboxChecked: false }) });
				}
			} as IDialogService, new TestExtensionService());

			const handle = await service.$showMessage(1, 'h', { modal: true }, [{ handle: 42, title: 'a thing', isCloseAffordance: true }]);
			assert.strictEqual(handle, 42);

			service.dispose();
		});
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});
