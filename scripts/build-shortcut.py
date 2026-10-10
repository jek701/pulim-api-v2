"""
Builds the iPhone Shortcut "Pulim — расход" (amount -> card -> category) for /shortcut/v1.

Usage (macOS):
  python3 scripts/build-shortcut.py unsigned.shortcut
  shortcuts sign --mode anyone --input unsigned.shortcut --output "Pulim — расход.shortcut"

The first action holds the personal key; an import question asks for it on install.
"""
import plistlib, uuid, sys

API = 'https://api.m-pulim.uz/shortcut/v1'
U = lambda: str(uuid.uuid4()).upper()
OBJ = '￼'

def out(uid, name):
    return {'OutputName': name, 'OutputUUID': uid, 'Type': 'ActionOutput'}

def attachment(uid, name):
    return {'Value': out(uid, name), 'WFSerializationType': 'WFTextTokenAttachment'}

def tokens(text, refs=()):
    """text with ￼ placeholders, refs = [(uuid, outputName)] in order."""
    by_range, pos, i = {}, 0, 0
    for ch_index, ch in enumerate(text):
        if ch == OBJ:
            uid, name = refs[i]; i += 1
            # NSRange is in UTF-16 units
            u16 = len(text[:ch_index].encode('utf-16-le')) // 2
            by_range[f'{{{u16}, 1}}'] = out(uid, name)
    return {'Value': {'string': text, 'attachmentsByRange': by_range}, 'WFSerializationType': 'WFTextTokenString'}

def dictionary(items):
    return {'Value': {'WFDictionaryFieldValueItems': items}, 'WFSerializationType': 'WFDictionaryFieldValue'}

def item(key, value, kind=0):
    return {'WFItemType': kind, 'WFKey': tokens(key), 'WFValue': value}

key_id, amount_id = U(), U()
cards_id, card_pick = U(), U()
cats_id, cat_pick = U(), U()
post_id = U()

auth_header = lambda: dictionary([item('Authorization', tokens('Bearer ' + OBJ, [(key_id, 'Text')]))])

actions = [
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.gettext',
     'WFWorkflowActionParameters': {'UUID': key_id, 'WFTextActionText': 'ВСТАВЬТЕ_КЛЮЧ_PULIM'}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.ask',
     'WFWorkflowActionParameters': {'UUID': amount_id, 'WFInputType': 'Number', 'WFAskActionPrompt': 'Сумма'}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
     'WFWorkflowActionParameters': {'UUID': cards_id, 'WFURL': f'{API}/cards', 'WFHTTPMethod': 'GET',
                                    'ShowHeaders': True, 'WFHTTPHeaders': auth_header()}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.choosefromlist',
     'WFWorkflowActionParameters': {'UUID': card_pick, 'WFInput': attachment(cards_id, 'Contents of URL'),
                                    'WFChooseFromListActionPrompt': 'Карта'}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
     'WFWorkflowActionParameters': {'UUID': cats_id, 'WFURL': f'{API}/categories', 'WFHTTPMethod': 'GET',
                                    'ShowHeaders': True, 'WFHTTPHeaders': auth_header()}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.choosefromlist',
     'WFWorkflowActionParameters': {'UUID': cat_pick, 'WFInput': attachment(cats_id, 'Contents of URL'),
                                    'WFChooseFromListActionPrompt': 'Категория'}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
     'WFWorkflowActionParameters': {
         'UUID': post_id, 'WFURL': f'{API}/expenses', 'WFHTTPMethod': 'POST',
         'ShowHeaders': True, 'WFHTTPHeaders': auth_header(), 'WFHTTPBodyType': 'JSON',
         'WFJSONValues': dictionary([
             item('amount', tokens(OBJ, [(amount_id, 'Provided Input')]), 3),
             item('card', tokens(OBJ, [(card_pick, 'Chosen Item')])),
             item('category', tokens(OBJ, [(cat_pick, 'Chosen Item')])),
         ])}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.notification',
     'WFWorkflowActionParameters': {'WFNotificationActionTitle': 'Pulim',
                                    'WFNotificationActionBody': tokens(OBJ, [(post_id, 'Contents of URL')])}},
]

workflow = {
    'WFWorkflowClientVersion': '3218.0.4',
    'WFWorkflowMinimumClientVersion': 900,
    'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {'WFWorkflowIconStartColor': 4282601983, 'WFWorkflowIconGlyphNumber': 59511},
    'WFWorkflowImportQuestions': [{
        'ActionIndex': 0, 'Category': 'Parameter', 'DefaultValue': '',
        'ParameterKey': 'WFTextActionText',
        'Text': 'Вставьте ключ из Pulim: Настройки → «Запись с iPhone» → «Скопировать ключ»',
    }],
    'WFWorkflowTypes': [],
    'WFQuickActionSurfaces': [],
    'WFWorkflowHasShortcutInputVariables': False,
    'WFWorkflowInputContentItemClasses': [],
    'WFWorkflowOutputContentItemClasses': [],
    'WFWorkflowActions': actions,
}
with open(sys.argv[1], 'wb') as f:
    plistlib.dump(workflow, f, fmt=plistlib.FMT_BINARY)
