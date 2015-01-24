var COMMAND = {
	SUCCESS: 0,
	UNAUTHORIZED: -1,
	NOT_FOUND: -2,
	EXECUTION_FAILED: -3,
	WAITING: -4,
	METHOD_NOT_ALLOWED: -5
};

COMMAND._createReverseMap();

var Command = function (type, event) {
	switch (type) {
		case 'global':
			var detail = {
				sourceName: 'Page',
				sourceID: Page.info.id,
				commandToken: Command.requestToken(event.name),
				command: event.name,
				data: event.message
			};
		break;

		case 'window':
			var detail = {
				sourceName: 'Page',
				sourceID: Page.info.id,
				commandToken: Command.requestToken(event.data.command),
				command: event.data.command,
				data: event.data.data
			};
		break;

		case 'injected':
			var detail = event.detail;
		break;
	}

	detail.type = type;

	var InternalCommand = function (detail, event) {
		this.status = COMMAND.WAITING;

		var canExecute = (detail.command && Utilities.Token.valid(detail.commandToken, detail.command, true) &&
			Utilities.Token.valid(detail.sourceID, detail.sourceName));

		if (!canExecute) {
			this.status = COMMAND.UNAUTHORIZED;

			return LogDebug('command authorization failed - ' + detail.sourceName + ' => ' + detail.command);
		}

		detail.type = Utilities.Token.valid(detail.sourceID, 'Page') ? (detail.type || 'injected') : 'injected';

		var commands = Commands[detail.type];

		if (!commands) {
			this.status = COMMAND.NOT_FOUND;

			return LogDebug('command type not found - ' + detail.type);
		}

		var part;

		var commandParts = detail.command.split(/\./g);

		if (commandParts.length > 1) {
			while (true) {
				if (commands.hasOwnProperty((part = commandParts.shift())))
					commands = commands[part];

				if (!(commands instanceof Object)) {
					this.status = COMMAND.NOT_FOUND;

					return LogDebug('command path not found - ' + detail.command);
				}

				if (commandParts.length === 1)
					break;
			}
		}

		if (commands !== Commands[detail.type])
			commands.__proto__ = Commands[detail.type];

		if (!commands.hasOwnProperty(commandParts[0])) {
			this.status = COMMAND.NOT_FOUND;

			return LogDebug('command not found - ' + type + ' - ' + commandParts[0]);
		}

		if (commandParts[0]._startsWith('__')) {
			this.status = COMMAND.NOT_FOUND;

			return LogDebug('cannot call commands that begin with __');
		}

		var command = commands[commandParts[0]];

		if (command.private && !TOKEN.INJECTED[detail.sourceID].private) {
			this.status = COMMAND.UNAUTHORIZED;

			return LogDebug('not authorized to execute private command - ' + detail.sourceName + ' => ' + detail.command);
		}

		if (!detail.originSourceID && command.topCallbackOnly) {
			this.status = COMMAND.METHOD_NOT_ALLOWED;

			return LogDebug('command must called with messageTopExtension - ' + detail.sourceName + ' => ' + detail.command);
		}

		try {
			this.result = command.call(commands, detail, event);

			this.status = COMMAND.SUCCESS;
		} catch (error) {
			this.status = COMMAND.EXECUTION_FAILED;

			return LogError(['command processing error', detail.sourceName + ' => ' + detail.command, detail], error);
		}
	};

	var Commands = {};

	Commands.global = {
		reload: function () {
			if (Utilities.Page.isTop)
				document.location.reload();
		},

		sendPage: function () {
			if (Utilities.Page.isTop)
				Page.send();
		},

		nextImmediateTimeout: function () {
			Utilities.nextImmediateTimeout();
		},

		messageTopExtension: function (detail, event) {
			if (!Utilities.Page.isTop)
				return;

			var data = detail.data.meta,
					foundSourceID = false;

			for (var token in TOKEN.INJECTED)
				if (TOKEN.INJECTED[token].namespace === data.originSourceName) {
					foundSourceID = token;

					break;
				}

			if (!foundSourceID)
				return LogDebug('cannot execute command on top since the calling script is not injected here - ' + data.originSourceName + ' - ' + document.location.href);

			var result = Special.JSBCommanderHandler({
				type: 'JSBCommander:' + foundSourceID + ':' + TOKEN.EVENT,

				detail: {
					originSourceID: data.originSourceID,
					commandToken: Command.requestToken(data.command, data.preserve),
					command: data.command,
					viaFrame: detail.data.viaFrame,
					meta: data.meta.args
				}
			});

			if (data.callback) {
				if (result && typeof result.then === 'function')
					var promise = result;
				else
					var promise = Promise.resolve(result);

				promise.then(function (result) {
					var name = 'TopCallback$' + data.originSourceName + '$' + Utilities.Token.generate(),
							script = new DeepInject(name, data.callback);

					script.setArguments({
						detail: {
							origin: data.originSourceID,
							result: result,
							meta: data.meta.meta
						}
					});

					var callback = UserScript.inject({
						private: TOKEN.INJECTED[foundSourceID].private,

						attributes: {
							parentUserScript: data.originSourceName,

							meta: {
								name: name,
								trueNamespace: name
							},

							script: script.executable()
						}
					}, data.originSourceName);
				});
			}
		},

		executeCommanderCallback: function (detail) {
			Command.sendCallback(detail.data.sourceID, detail.data.callbackID, detail.data.result);
		},

		executeMenuCommand: function (detail) {
			if (detail.data.pageID === Page.info.id) {
				var target = document.querySelector('*[data-jsbContextMenuTarget="' + detail.data.contextMenuTarget + '"]');

				Command.sendCallback(detail.data.sourceID, detail.data.callbackID, target);
			}
		},

		receiveFrameInfo: function (detail) {
			if (Utilities.Page.isTop && detail.data.attachTo === Page.info.id) {
				FRAMED_PAGES[detail.data.info.id] = detail.data.info;

				Page.send();
			}
		},

		getFrameInfo: function (detail) {
			if (detail.data.frameID === Page.info.id)
				setTimeout(function (detail) {
					GlobalPage.message('bounce', {
						command: 'receiveFrameInfo',
						detail: {
							attachTo: detail.data.attachTo,
							info: Page.info
						}
					});
				}, 0, detail);
		},

		recommendPageReload: function () {
			if (Utilities.Page.isTop && !RECOMMEND_PAGE_RELOAD) {
				RECOMMEND_PAGE_RELOAD = true;

				var autoReload = GlobalCommand('settingStore.getItem', {
					setting: 'recommendReloadAlways'
				});

				if (autoReload)
					window.location.reload();
				else {
					var notification = new PageNotification({
						title: _('recommend_reload.title'),
						subTitle: document.location.href,
						body: GlobalCommand('template.create', {
							template: 'injected',
							section: 'recommend-reload'
						})
					});

					var reloadPageButton = notification.addCloseButton(_('recommend_reload.reload_once'), function (notification) {
						GlobalPage.message('settingStore.setItem', {
							setting: 'recommendReloadAlways',
							value: PageNotification.willCloseAll
						});

						window.location.reload();
					});

					notification.addCustomEventListener('optionKeyStateChange', function (event) {
						reloadPageButton.value = event.detail ? _('recommend_reload.reload_always') : _('recommend_reload.reload_once');
					});
				}
			}
		},

		showJSBUpdatePrompt: function (detail) {
			if (Page.info.isFrame || SHOWED_UPDATE_PROMPT)
				return;

			SHOWED_UPDATE_PROMPT = true;

			var notification = new PageNotification({
				id: 'update-attention-required',
				highPriority: true,
				title: 'JSB Update',
				body: GlobalCommand('template.create', {
					template: 'injected',
					section: 'javascript-alert',
					data: {
						body: 'Attention required.'
					}
				})
			});

			notification.primaryCloseButtonText(_('open_popover')).onPrimaryClose(function () {
				GlobalPage.message('showPopover');
			});
		},

		notification: function (detail) {
			if (!Utilities.Page.isTop)
				return;

			var notification = new PageNotification(detail.data);
		},

		showBlockedAllFirstVisitNotification: function (detail) {
			Handler.showBlockedAllFirstVisitNotification(detail.data, true);
		}
	};

	Commands.window = {
		getFrameInfoWithID: function (detail, event) {	
			if (Utilities.Page.isTop)
				GlobalPage.message('bounce', {
					command: 'getFrameInfo',
					detail: {
						attachTo: Page.info.id,
						frameID: detail.data
					}
				});
		},

		requestFrameURL: function (detail, event) {
			FRAME_ID_ON_PARENT = detail.data.id;

			window.parent.postMessage({
				command: 'receiveFrameURL',
				data: {
					id: detail.data.id,
					reason: detail.data.reason,
					url: Page.info.location,
					token: detail.data.token
				}
			}, event.origin);
		},

		rerequestFrameURL: function (detail) {
			Element.requestFrameURL(document.getElementById(detail.data.id), detail.data.reason);
		},

		receiveFrameURL: function (detail) {
			var message = detail.data;

			if (!Utilities.Token.valid(message.token, message.id, true))
				return LogDebug('invalid token received for frame URL.', message);

			var frame = document.getElementById(message.id);

			Utilities.Timer.remove('timeout', 'FrameURLRequestFailed' + message.id);

			if (!frame) {
				LogDebug('received frame URL, but frame does not exist - ' + message.id);

				frame = Element.createFromObject('iframe', {
					id: message.id
				});
			} else {
				Utilities.Token.expire(frame.getAttribute('data-jsbAllowLoad'));

				var locationURL,
						locationURLStore,
						frameURL,
						frameURLStore,
						frameItemID;

				var frameSources = Page.allowed.getStore('frame').getStore('source'),
						allFrameSources = frameSources.all();

				for (locationURL in allFrameSources) {
					locationURLStore = frameSources.getStore(locationURL);

					for (frameURL in allFrameSources[locationURL]) {
						frameURLStore = locationURLStore.getStore(frameURL);

						for (frameItemID in allFrameSources[locationURL][frameURL]) {
							if (allFrameSources[locationURL][frameURL][frameItemID].meta && allFrameSources[locationURL][frameURL][frameItemID].meta.waiting && allFrameSources[locationURL][frameURL][frameItemID].meta.id === message.id) {
								frameURLStore.remove(frameItemID);

								Page.allowed.decrementHost('frame', Utilities.URL.extractHost(frameURL));
							}
						}
					}
				}
			}

			var previousURL = frame ? frame.getAttribute('data-jsbFrameURL') : 'about:blank',
					previousURLTokenString = previousURL + 'FrameURL';

			if (frame && !Utilities.Token.valid(frame.getAttribute('data-jsbFrameURLToken'), previousURLTokenString))
				return;

			if (previousURL !== message.url)
				Element.afterCanLoad({
					reason: message.reason,
					previousURL: previousURL
				}, frame, false, {
					isAllowed: true,
					action: -1
				}, message.url, {
					target: frame,
					url: message.url,
					unblockable: true
				}, null, 'frame');

			if (frame) {
				Utilities.Token.expire(previousURLTokenString);

				frame.setAttribute('data-jsbFrameURL', message.url);
				frame.setAttribute('data-jsbFrameURLToken', Utilities.Token.create(message.url + 'FrameURL', true));
			}
		},

		historyStateChange: function (detail, event) {
			Handler.setPageLocation();

			if (Page.info.isFrame)
				window.parent.postMessage({
					command: 'rerequestFrameURL',
					data: {
						id: FRAME_ID_ON_PARENT,
						reason: 'historyStateDidChange'
					}
				}, '*');

			Page.send();
		}
	};

	Commands.injected = {
		__userScriptAction: function (detail) {
			detail.meta = {
				namespace: TOKEN.INJECTED[detail.sourceID].namespace,
				meta: detail.meta
			};

			return {
				callbackID: detail.callbackID,
				result: GlobalCommand(detail.command, detail.meta)
			};
		},

		__addPageItem: function (isAllowed, detail) {
			var info = detail.meta,
					actionStore = isAllowed ? Page.allowed : Page.blocked;

			info.source = Utilities.URL.getAbsolutePath(info.source);
			info.host = Utilities.URL.extractHost(info.source);

			var resourceID = actionStore.pushSource(info.kind, info.source, {
				action: info.canLoad.action,
				unblockable: false,
				meta: info.meta
			});

			actionStore.incrementHost(info.kind, info.host);

			Page.send();

			return {
				callbackID: detail.callbackID,
				result: resourceID
			};
		},

		__modifyPageItem: function (isAllowed, detail) {
			var info = detail.meta,
					actionStore = isAllowed ? Page.allowed : Page.blocked,
					found = actionStore.deepFindKey(info.resourceID);

			found.store.set(found.key, {
				action: info.canLoad.action,
				unblockable: info.unblockable,
				meta: info.meta
			});

			Page.send();
		},

		commandGeneratorToken: function (detail) {
			return {
				sourceID: detail.sourceID,
				callbackID: detail.callbackID,
				result: {
					commandGeneratorToken: Command.requestToken('commandGeneratorToken'),
					commandToken: Command.requestToken(detail.meta.command),
					command: detail.meta.command
				}
			};
		},

		registerDeepInjectedScript: function (detail, event) {
			if (TOKEN.REGISTERED[detail.sourceID])
				throw new Error('cannot register a script more than once - ' + TOKEN.INJECTED[detail.sourceID].namespace);

			var newSourceID = Utilities.Token.create(detail.sourceName, true);

			document.removeEventListener('JSBCommander:' + detail.sourceID + ':' + TOKEN.EVENT, Special.JSBCommanderHandler, true);
			document.addEventListener('JSBCommander:' + newSourceID + ':' + TOKEN.EVENT, Special.JSBCommanderHandler, true);

			TOKEN.INJECTED[newSourceID] = TOKEN.INJECTED[detail.sourceID];

			delete TOKEN.INJECTED[detail.sourceID];

			TOKEN.REGISTERED[newSourceID] = true;

			return {
				sourceID: detail.sourceID,
				callbackID: detail.callbackID,
				result: {
					previousSourceID: detail.sourceID,
					newSourceID: newSourceID
				}
			};
		},

		executeCommanderCallback: function (detail) {
			GlobalPage.message('bounce', {
				command: 'executeCommanderCallback',
				detail: {
					sourceID: detail.meta.originSourceID || detail.meta.sourceID,
					callbackID: detail.meta.callbackID,
					result: detail.meta.result
				}
			});
		},

		messageTopExtension: function (detail, event) {
			if (document.hidden) {
				event.detail.commandToken = Command.requestToken('messageTopExtension');

				Handler.event.addCustomEventListener('documentBecameVisible', Command.bind(window, 'injected', event), true);
			} else {
				detail.meta.originSourceName = TOKEN.INJECTED[detail.sourceID].namespace;
				detail.meta.originSourceID = detail.sourceID;

				GlobalPage.message('bounce', {
					command: 'messageTopExtension',
					detail: detail
				});
			}
		},

		inlineScriptsAllowed: function (detail) {
			if (TOKEN.INJECTED[detail.sourceID].usedURL)
				return;

			DeepInject.useURL = false;
		},

		registerMenuCommand: function (detail) {
			if (typeof detail.meta !== 'string' || !detail.meta.length)
				return LogError(['caption is not a valid string', detail.meta]);

			detail.meta = TOKEN.INJECTED[detail.sourceID].name + ' - ' + detail.meta;

			if (UserScript.menuCommand[detail.meta])
				return LogDebug('menu item with caption already exist - ' + detail.meta);

			UserScript.menuCommand[detail.meta] = {
				sourceID: detail.sourceID,
				callbackID: detail.callbackID
			};
		},

		XMLHttpRequest: function (detail) {
			detail.meta.url = Utilities.URL.getAbsolutePath(detail.meta.url);

			var result = GlobalCommand(detail.command, detail);

			if (result !== false)
				return {
					callbackID: detail.callbackID,
					result: result
				};
		},

		showXHRPrompt: function (detail) {
			var self = this,
					meta = detail.meta.meta;

			var response = {
				meta: {
					sourceID: detail.originSourceID,
					callbackID: detail.meta.onXHRPromptInput,
					result: {
						isAllowed: false,
						send: false
					}
				}
			};

			var xhrPrompt = GlobalCommand('template.create', {
				template: 'injected',
				section: 'xhr-prompt',
				data: {
					synchronousInfoOnly: detail.meta.synchronousInfoOnly,
					synchronousInfoIsAllowed: detail.meta.synchronousInfoIsAllowed,
					info: detail.meta.meta
				}
			});

			var subTitle = detail.viaFrame ? [_('via_frame')] : [];

			if (detail.meta.synchronousInfoOnly)
				subTitle.push(_('xhr.synchronous'), _(detail.meta.synchronousInfoIsAllowed ? 'xhr.sync.auto_allowed' : 'xhr.sync.auto_blocked'));

			subTitle.push(Page.info.location);

			var notification = new PageNotification({
				closeAllID: detail.meta.synchronousInfoOnly ? undefined : 'xhr',
				title: _(meta.kind + '.prompt.title'),
				subTitle: subTitle.join(' - '),
				body: xhrPrompt
			});

			if (!detail.meta.synchronousInfoOnly) {
				notification.primaryCloseButtonText(_('xhr.block_once')).primaryCloseButton.classList.add('jsb-color-blocked');

				var allowOnceButton = notification.addCloseButton(_('xhr.allow_once'), function (notification) {
					if (PageNotification.willCloseAll) {
						for (var notificationID in PageNotification.notifications)
							if (PageNotification.notifications[notificationID].shouldObeyCloseAll())
								PageNotification.notifications[notificationID].trigger('allowXHR');
					} else
						notification.trigger('allowXHR');
				});

				allowOnceButton.classList.add('jsb-color-allowed');

				notification
					.addCustomEventListener('optionKeyStateChange', function (event) {
						allowOnceButton.value = event.detail ? _('xhr.allow_once_all') : _('xhr.allow_once');

						notification.primaryCloseButtonText(event.detail ? _('xhr.block_once_all') : _('xhr.block_once'));
					})

					.addCustomEventListener(['allowXHR', 'blockXHR'], function () {
						notification.hide();

						if (response.meta.result.send) {
							var send = [],
									query = notification.element.querySelectorAll('.jsb-xhr-query-view');

							for (var i = 0; i < query.length; i++)
								send.push(query[i].querySelector('.jsb-xhr-query-param').getAttribute('data-param') + '=' + query[i].querySelector('.jsb-xhr-query-value').getAttribute('data-value'))

							response.meta.result.send = send.join('&');
						}
					}, true)

					.addCustomEventListener('allowXHR', function () {
						response.meta.result.isAllowed = true;

						self.executeCommanderCallback(response);
					}, true);

				notification
					.addEventListener('dblclick', '.jsb-xhr-query-view', function (notification, event) {
						notification.bringForward();

						var queryModify = this.nextElementSibling;
						
						this.classList.add('jsb-hidden');

						queryModify.classList.remove('jsb-hidden');

						try {
							queryModify.querySelector('.' + event.target.classList[0] + '-modify').focus();
						} catch (error) {}

						PageNotification.totalShift();
					})

					.addEventListener('keypress', '.jsb-xhr-query-modify input', function (notification, event) {
						if (event.keyCode === 3 || event.keyCode === 13) {
							this.blur();

							response.meta.result.send = true;

							var queryPartFor,
									queryPart;

							var inputs = this.parentNode.querySelectorAll('input'),
									queryView = this.parentNode.previousElementSibling;

							for (var i = 0; i < inputs.length; i++) {
								queryPartFor = inputs[i].getAttribute('data-for');
								queryPart = queryView.querySelector('*[' + queryPartFor + ']');

								queryPart.innerText = inputs[i].value;

								queryPart.setAttribute(queryPartFor, encodeURIComponent(inputs[i].value));
							}

							this.parentNode.classList.add('jsb-hidden');

							queryView.classList.remove('jsb-hidden');

							PageNotification.totalShift();
						}
					});
			}

			notification.addCustomEventListener('blockXHR', function () {
				response.meta.result.isAllowed = false;

				self.executeCommanderCallback(response);
			}, true);

			notification.onPrimaryClose(function (notification) {
				if (PageNotification.willCloseAll) {
					for (var notificationID in PageNotification.notifications)
						if (PageNotification.notifications[notificationID].shouldObeyCloseAll())
							PageNotification.notifications[notificationID].trigger('blockXHR');
				} else
					notification.trigger('blockXHR');
			});

			notification.addEventListener('click', '.jsb-xhr-create-rule', function (notification) {
				GlobalPage.message('showPopover');

				var originalValue = this.value;

				this.disabled = true;
				this.value = 'Popover Opened';

				setTimeout(function (self) {
					self.disabled = false;
					self.value = originalValue;
				}, 2000, this);
			});
		},

		notification: function (detail) {
			return new Promise(function (resolve, reject) {				
				var info = TOKEN.INJECTED[detail.sourceID];

				if (info.isUserScript)
					detail.meta.subTitle = info.name + (detail.meta.subTitle ? ' - ' + detail.meta.subTitle : '');

				if (detail.viaFrame)
					detail.meta.subTitle = _('via_frame') + ' - ' + detail.meta.subTitle;

				var notification = new PageNotification(detail.meta);

				if (detail.meta.closeButtons)
					for (var i = 0; i < detail.meta.closeButtons.length; i++) {
						notification.addCloseButton(detail.meta.closeButtons[i].title, function (callbackID, notification) {
							Command.sendCallback(detail.sourceID, callbackID, true);
						}.bind(null, detail.meta.closeButtons[i].callbackID));
					}

				Handler.event.addCustomEventListener('stylesheetLoaded', function () {
					resolve(notification.element.id);
				}, true);
			});
		},

		canLoadResource: function (detail) {
			var toCheck = detail.meta;

			toCheck.pageLocation = Page.info.location;
			toCheck.pageProtocol = Page.info.protocol;
			toCheck.isFrame = Page.info.isFrame;
			toCheck.source = (toCheck.kind === 'special' || toCheck.kind === 'user_script' || toCheck.kind === 'disable') ? toCheck.source : Utilities.URL.getAbsolutePath(toCheck.source);

			return {
				callbackID: detail.callbackID,
				result: GlobalCommand('canLoadResource', toCheck)
			};
		},

		testCommand: function (detail) {
			return 3;
		},

		confirm: function (detail) {
			for (var i = 0; i < 1000; i++)
				GlobalCommand('ping');

			return Command.globalRelay(detail);
		},

		showPopover: function (detail) {
			Command.globalRelay(detail);
		},

		openTabWithURL: function (detail) {
			return Command.globalRelay(detail);
		},

		activeTabIndex: function (detail) {
			return Command.globalRelay(detail);
		},

		closeTabAtIndex: function (detail) {
			Command.globalRelay(detail);
		},

		activateTabAtIndex: function (detail) {
			Command.globalRelay(detail);
		},

		localize: function (detail) {
			return Command.globalRelay(detail);
		},

		extensionURL: function (detail) {
			return {
				callbackID: detail.callbackID,
				result: ExtensionURL(detail.meta.path)
			};
		},

		addResourceRule: function (detail) {
			var ruleInfo = detail.meta.resource;

			ruleInfo.pageLocation = Page.info.location;
			ruleInfo.pageProtocol = Page.info.protocol;
			ruleInfo.isFrame = Page.info.isFrame;

			GlobalPage.message('addResourceRule', detail.meta);

			return {
				callbackID: detail.callbackID,
				result: true
			};
		},

		installUserScriptFromURL: function (detail) {
			return {
				callbackID: detail.callbackID,
				result: GlobalCommand('installUserScriptFromURL', detail.meta.url)
			};
		},

		template: {
			create: function (detail) {
				return Command.globalRelay(detail);
			}
		},

		userScript: {
			getResource: function (detail) {
				return this.__userScriptAction(detail);
			},

			storage: {
				getItem: function (detail) {
					return this.__userScriptAction(detail);
				},

				setItem: function (detail) {
					return this.__userScriptAction(detail);
				},

				keys: function (detail) {
					return this.__userScriptAction(detail);
				}
			}
		},

		page: {
			addBlockedItem: function (detail) {
				return this.__addPageItem(false, detail);
			},

			addAllowedItem: function (detail) {
				return this.__addPageItem(true, detail);
			},

			modifyBlockedItem: function (detail) {
				return this.__modifyPageItem(false, detail);
			},

			modifyAllowedItem: function (detail) {
				return this.__modifyPageItem(true, detail);
			}
		}
	};

	Commands.injected.notification.topCallbackOnly = true;
	Commands.injected.showXHRPrompt.topCallbackOnly = true;

	Commands.injected.inlineScriptsAllowed.private = true;
	Commands.injected.addResourceRule.private = true;
	Commands.injected.installUserScriptFromURL.private = true;

	var command = new InternalCommand(detail, event);

	if (command.status === COMMAND.SUCCESS)
		return command.result;
	else
		return new Error(command.status);
};

Command.requestToken = function (command) {
	return Utilities.Token.create(command);
};

Command.sendCallback = function (sourceID, callbackID, result) {
	document.dispatchEvent(new CustomEvent('JSBCallback:' + sourceID + ':' + TOKEN.EVENT, {
		detail: {
			callbackID: callbackID,
			result: result
		}
	}));
};

Command.globalRelay = function (detail) {
	return {
		callbackID: detail.callbackID,
		result: GlobalCommand(detail.command, detail.meta)
	};
};

Command.global = function (event) {
	// Somehow prevents excessive "Blocked a frame with origin..." errors. While it does not affect functionality, it does
	// look ugly.
	console.log;

	if (event.message)
		try {
			event.message = JSON.parse(event.message);
		} catch (error) {}

	Command('global', event);
};

Command.window = function (event) {
	if (!(event.data instanceof Object) || !event.data.command)
		return;

	Command('window', event);
};

Events.addTabListener('message', Command.global, true);

window.addEventListener('message', Command.window, true);
