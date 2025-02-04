import * as vscode from 'vscode';
import {vscodeContext, outputChannel} from './extension'
import {showErrorMessageWithHelp, mapToObj, objToMap, safeQueryObject} from './utils'
import {getFile, saveFile, exists} from './helper/file_utils'
import * as azure from './helper/azure'
import * as profile from './profile'
import { PIMView } from './ui/pim';
import exp = require('constants');

export var ui: PIMView;
export var activeProfile: profile.Profile | undefined = undefined;

var roles: azure.pim.Role[];
var autoActivationEnabled: Map<string, boolean> = new Map();
var planedTasks: Map<string, NodeJS.Timeout> = new Map();

function addPlanedTask(role: azure.pim.Role, planedTime: Date) {
    planedTasks.set(role.name, setTimeout(async () => {
        let response: any;
        try {
            response = await azure.pim.getRoleAssignment(role, activeProfile!.azureConfigDir);
        } catch (error) {
            if (error === 'role_assignment_not_found') {
                if (autoActivationEnabled.get(role.name)) {
                    // Expired, activate again
                    ui.update(role.name, 'deactivated');
                    try {
                        await activate(role.name);
                    } catch (error) {
                        if (error === 'role_assignment_exists') {
                            addPlanedTask(role, new Date(planedTime.getTime() + 60000));
                            return;
                        }
                        throw error;
                    }
                }
                else {
                    ui.update(role.name, 'deactivated');
                }
            }
            else {
                ui.update(role.name, 'deactivated');
                showErrorMessageWithHelp(`Failed to get role assignment: ${error}`);
            }
            return;
        }
        // Not expired yet, plan another task after 1 minutes
        addPlanedTask(role, new Date(planedTime.getTime() + 60000));
    }, planedTime.getTime() - Date.now()));
    console.log(planedTasks);
}

export interface uiParams {
    roles: azure.pim.Role[];
    autoActivationEnabled: Map<string, boolean>;
    activeProfile: profile.Profile | undefined;
}

export async function refreshUI() {
    ui.setContent({roles: roles, autoActivationEnabled: mapToObj(autoActivationEnabled), activeProfile: activeProfile});
}

export async function activate(name: string) {
    let role = roles.find(role => role.name === name)!;
    if (role === undefined) return;
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Activating ${role.displayName} of ${role.resourceName}...`,
        cancellable: false
    }, async () => {
        let response: any;
        try {
            await azure.pim.activateRole(role, activeProfile!.azureConfigDir);
        } catch (error) {
            if (safeQueryObject(error, 'error.code') === 'RoleAssignmentExists') {
                // Not expired yet, plan another task after 1 minutes
                throw 'role_assignment_exists';
            }
            showErrorMessageWithHelp(`Failed to activate role: ${error}`);
            ui.update(role.name, 'deactivated');
            throw 'failed_to_activate_role'
        }
        ui.update(role.name, 'validating');
        while (true) {
            try {
                await new Promise(resolve => setTimeout(resolve, 5000));
                response = await azure.pim.getRoleAssignment(role, activeProfile!.azureConfigDir);
                if (response.properties.assignmentType === 'Activated') break;
            } catch (error) {}
        }
        role.assignmentName = response.name;
        role.assignmentType = response.properties.assignmentType;
        role.startDateTime = response.properties.startDateTime;
        role.endDateTime = response.properties.endDateTime;
        addPlanedTask(role, new Date(role.endDateTime!));
        vscode.window.showInformationMessage('Role activated successfully');
        ui.update(role.name, 'activated');
    });
}

export async function deactivate(name: string) {
    let role = roles.find(role => role.name === name)!;
    if (role === undefined) return;
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Deactivating ${role.displayName} of ${role.resourceName}...`,
        cancellable: false
    }, async () => {
        try {
            await azure.pim.deactivateRole(role, activeProfile!.azureConfigDir);
        } catch (error) {
            showErrorMessageWithHelp(`Failed to deactivate role: ${error}`);
            ui.update(role.name, 'activated');
            throw 'failed_to_deactivate_role'
        }
        delete role.assignmentName;
        delete role.assignmentType;
        delete role.startDateTime;
        delete role.endDateTime;
        if (planedTasks.has(role.name)) {
            clearTimeout(planedTasks.get(role.name)!);
            planedTasks.delete(role.name);
        }
        vscode.window.showInformationMessage('Role deactivated successfully');
        ui.update(role.name, 'deactivated');
    });
}

export async function enableAutoActivation(name: string) {
    let role = roles.find(role => role.name === name)!;
    if (role === undefined) return;
    autoActivationEnabled.set(role.name, true);
    savePIMCache();
}

export async function disableAutoActivation(name: string) {
    let role = roles.find(role => role.name === name)!;
    if (role === undefined) return;
    autoActivationEnabled.set(role.name, false);
    savePIMCache();
}

function savePIMCache() {
    if (activeProfile === undefined) return;
    let cachePath = `${activeProfile.userDataPath}/pim.json`;
    saveFile(cachePath, JSON.stringify({autoActivationEnabled: mapToObj(autoActivationEnabled)}, null, 4));
}

function loadPIMCache() {
    if (activeProfile === undefined) return;
    let cachePath = `${activeProfile.userDataPath}/pim.json`;
    if (exists(cachePath)) {
        let cache = JSON.parse(getFile(cachePath));
        autoActivationEnabled = objToMap(cache.autoActivationEnabled);
    }
}

export function loggedOut() {
    activeProfile = undefined;
    roles = [];
    autoActivationEnabled = new Map();
    planedTasks.forEach(clearTimeout);
    planedTasks.clear();
    refreshUI();
}

export async function loggedIn(profile: profile.Profile) {
    activeProfile = profile
    loadPIMCache();
    refreshUI();
}

export function init() {
    outputChannel.appendLine('[INFO] Initializing Privileged Identity Management module...');

    vscodeContext.subscriptions.push(vscode.commands.registerCommand('msra_intern_s_toolkit.refreshPIMRoles', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Loading PIM roles...',
            cancellable: false
        }, async () => {
            planedTasks.forEach(clearTimeout);
            planedTasks.clear();
            roles = await azure.pim.getRoles(activeProfile!.azureConfigDir);
            let copy = new Map(Array.from(autoActivationEnabled));
            autoActivationEnabled.clear();
            for (let role of roles) {
                autoActivationEnabled.set(role.name, copy.get(role.name) || false);
                if (role.assignmentType === 'Activated') {
                    addPlanedTask(role, new Date(role.endDateTime!));
                }
            }
            savePIMCache();
            refreshUI();
        });
    }));

    ui = new PIMView();
    vscodeContext.subscriptions.push(vscode.window.registerWebviewViewProvider(
        'msra_intern_s_toolkit_view_PIM',
        ui,
        {webviewOptions: {retainContextWhenHidden: true}}
    ));
}
