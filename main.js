// Obsidian 插件：custom-search
// 功能：
// 1. 自定義搜索範圍（文件組/組合，支持包含/排除正則）
// 2. 三種結果顯示模式（A:單行截取 / B:三行滾動 / C:三行展開），支持全局默認和單條獨立切換
// 3. 搜索結果排序（文件優先級 → 組間優先級 → 組內模式優先級）
// 4. 搜索歷史記錄與導航（快捷鍵 Ctrl+←/→）
// 5. 原生搜索框查詢生成與執行

const { Plugin, ItemView, Notice, TFile, PluginSettingTab, Setting, MarkdownRenderer, Modal, Menu } = require('obsidian');

const VIEW_TYPE_SEARCH_RESULT = "custom-search-result-view";

// ==================== 輔助函數 ====================
function isRegexPattern(str) {
    if (!str) return false;
    // 檢查是否包含正則特殊字符： * + ? $ { } [ ] \
    return /[*+?${}[\]\\]/.test(str);
}

/**
 * 將布爾表達式轉換為 Obsidian 原生搜索語法
 * 注意：這個全局函數同時被 buildNativeSearchQuery 和類方法調用
 */
function convertBooleanToNative(query) {
    if (!query || !query.trim()) return query;
    
    let result = query;
    // 替換 & 為空格（原生語法中空格就是 AND）
    result = result.replace(/\s+&\s+|\s+&|&\s+/g, ' ');
    result = result.replace(/&/g, ' ');
    // 替換 | 為 OR
    result = result.replace(/\s+\|\s+|\s+\||\|\s+/g, ' OR ');
    result = result.replace(/\|/g, ' OR ');
    // 替換 ! 為 -
    result = result.replace(/!\s*/g, '-');
    // 括號保留
    return result;
}

// ==================== 變音符號忽略功能 ====================
// 七組字符家族映射（雙向閉包）
const DIACRITIC_FAMILIES = [
    { members: ['a', 'ā', 'â'], regex: '[aāâ]' },
    { members: ['i', 'ī', 'î'], regex: '[iīî]' },
    { members: ['u', 'ū', 'û'], regex: '[uūû]' },
    { members: ['s', 'ṣ', 'ś'], regex: '[sṣś]' },
    { members: ['t', 'ṭ'], regex: '[tṭ]' },
    { members: ['d', 'ḍ'], regex: '[dḍ]' },
    { members: ['n', 'ṇ', 'ñ', 'ṅ'], regex: '[nṇñṅ]' },
    { members: ['m', 'ṃ'], regex: '[mṃ]' },
    { members: ['h', 'ḥ'], regex: '[hḥ]' }
];

// 構建從字符到家族正則的映射表
const charToFamilyRegex = new Map();
for (const family of DIACRITIC_FAMILIES) {
    for (const member of family.members) {
        charToFamilyRegex.set(member, family.regex);
    }
}

// 檢查字符是否屬於七組家族
function isDiacriticFamilyChar(ch) {
    return charToFamilyRegex.has(ch);
}

// 獲取字符對應的家族正則
function getFamilyRegex(ch) {
    return charToFamilyRegex.get(ch) || ch;
}

/**
 * 將正則表達式轉換為忽略變音符號的版本
 * @param {string} regexStr - 原始正則表達式字符串
 * @returns {string} 轉換後的正則表達式字符串
 */
function convertRegexToIgnoreDiacritics(regexStr) {
    if (!regexStr || typeof regexStr !== 'string') return regexStr;
    
    let result = '';
    let i = 0;
    const len = regexStr.length;
    let inCharClass = false;
    let charClassContent = '';
    let charClassStartIndex = -1;
    
    while (i < len) {
        const ch = regexStr[i];
        const prevCh = i > 0 ? regexStr[i - 1] : '';
        const isEscaped = prevCh === '\\';
        
        // 處理轉義字符：跳過下一個字符
        if (ch === '\\' && !isEscaped) {
            // 輸出轉義符和下一個字符（保持原樣）
            result += ch;
            i++;
            if (i < len) {
                result += regexStr[i];
                i++;
            }
            continue;
        }
        
        // 處理字符組邊界
        if (ch === '[' && !isEscaped) {
            if (inCharClass) {
                // 嵌套字符組（正則中不應出現，但穩健處理）
                charClassContent += ch;
            } else {
                // 進入字符組
                inCharClass = true;
                charClassContent = '';
                charClassStartIndex = i;
            }
            i++;
            continue;
        }
        
        if (ch === ']' && !isEscaped && inCharClass) {
            // 退出字符組，處理字符組內容
            const processedClass = processCharClassContent(charClassContent);
            result += '[' + processedClass + ']';
            inCharClass = false;
            charClassContent = '';
            i++;
            continue;
        }
        
        // 在字符組內部
        if (inCharClass) {
            charClassContent += ch;
            i++;
            continue;
        }
        
        // 不在字符組內部，處理普通字符
        // 檢查雙元音特例 au 和 ai
        if (i + 1 < len && ((ch === 'a' && regexStr[i + 1] === 'u') || (ch === 'a' && regexStr[i + 1] === 'i'))) {
            // 檢查前面是否有轉義（已處理），且不在字符組內
            // 輸出原樣 au 或 ai
            result += ch + regexStr[i + 1];
            i += 2;
            continue;
        }
        
        // 檢查是否為家族字符
        if (isDiacriticFamilyChar(ch)) {
            result += getFamilyRegex(ch);
        } else {
            result += ch;
        }
        i++;
    }
    
    // 如果字符組未閉合（輸入正則不完整），處理殘留內容
    if (inCharClass) {
        result += '[' + charClassContent;
    }
    
    return result;
}

/**
 * 處理字符組內部的內容
 * @param {string} content - 字符組內部的內容（不包括方括號）
 * @returns {string} 處理後的內容
 */
function processCharClassContent(content) {
    if (!content) return content;
    
    // 檢查是否為範圍 [a-z] 形式
    // 匹配 單字符-單字符 的範圍模式
    const rangeMatch = content.match(/^([a-zA-Z])-([a-zA-Z])$/);
    if (rangeMatch) {
        // 範圍轉為 \p{Latin}
        return '\\p{L}';
    }
    
    // 檢查連字符作為字面字符的情況：[a-z-] 或 [-az]
    // 如果連字符在開頭或結尾，保留原樣（不當作範圍處理）
    const hasRangeSyntax = /[a-zA-Z]-[a-zA-Z]/.test(content);
    if (hasRangeSyntax) {
        // 有實際的範圍語法，整個字符組轉為 \p{Latin}
        // 但要注意連字符在結尾的情況，如 [a-z-]
        if (content.endsWith('-') && content.length > 3) {
            // [a-z-] 中的 - 是字面，但 a-z 是範圍
            // 轉換為 [\p{Latin}-]
            return '\\p{L}-';
        }
        return '\\p{L}';
    }
    
    // 處理取反符號
    let isNegated = false;
    let innerContent = content;
    if (content.startsWith('^')) {
        isNegated = true;
        innerContent = content.substring(1);
    }
    
    // 處理普通字符組內容：逐字符擴展家族，去重保持順序
    const expandedChars = [];
    const seenChars = new Set();
    
    for (let i = 0; i < innerContent.length; i++) {
        const ch = innerContent[i];
        // 跳過轉義字符（不處理）
        if (ch === '\\') {
            expandedChars.push(ch);
            if (i + 1 < innerContent.length) {
                expandedChars.push(innerContent[i + 1]);
                i++;
            }
            continue;
        }
        
        // 檢查是否為家族字符
        if (isDiacriticFamilyChar(ch)) {
            const familyRegex = getFamilyRegex(ch);
            // 提取家族正則中的字符（去掉方括號）
            const familyChars = familyRegex.slice(1, -1);
            for (const fc of familyChars) {
                if (!seenChars.has(fc)) {
                    seenChars.add(fc);
                    expandedChars.push(fc);
                }
            }
        } else {
            if (!seenChars.has(ch)) {
                seenChars.add(ch);
                expandedChars.push(ch);
            }
        }
    }
    
    let result = expandedChars.join('');
    if (isNegated) {
        result = '^' + result;
    }
    
    return result;
}

/**
 * 將普通文本轉換為忽略變音符號的正則表達式
 * @param {string} text - 普通文本
 * @returns {string} 正則表達式字符串
 */
function convertPlainTextToIgnoreDiacritics(text) {
    if (!text) return text;
    // 先轉義正則特殊字符
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 然後應用正則轉換規則
    return convertRegexToIgnoreDiacritics(escaped);
}

function parsePatternsToRegexArray(patternsText) {
    if (!patternsText || !patternsText.trim()) {
        return [];
    }
    const lines = patternsText.split(/\r?\n/);
    const regexArray = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            try {
                regexArray.push(new RegExp(trimmed));
            } catch (e) {
                new Notice(`⚠️ 正則表達式錯誤：${trimmed}\n${e.message}`);
            }
        }
    }
    return regexArray;
}

function parsePatternsWithExcludes(patternsText) {
    if (!patternsText || !patternsText.trim()) {
        return { includePatterns: [], excludePatterns: [], mode: 'include-only' };
    }
    
    const lines = patternsText.split(/\r?\n/);
    const includePatterns = [];
    const excludePatterns = [];
    let hasInclude = false;
    let hasExclude = false;
    
    // 第一遍：分離包含和排除
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        
        // 處理轉義的 \! -> 字面 !
        let processedLine = trimmed;
        let isExclude = false;
        
        if (trimmed.startsWith('!') && !trimmed.startsWith('\\!')) {
            isExclude = true;
            processedLine = trimmed.substring(1);
        } else if (trimmed.startsWith('\\!')) {
            processedLine = '!' + trimmed.substring(2);
        }
        
        if (isExclude) {
            hasExclude = true;
            try {
                excludePatterns.push(new RegExp(processedLine));
            } catch (e) {
                new Notice(`⚠️ 排除正則錯誤：${processedLine}\n${e.message}`);
            }
        } else {
            hasInclude = true;
            try {
                includePatterns.push(new RegExp(processedLine));
            } catch (e) {
                new Notice(`⚠️ 包含正則錯誤：${processedLine}\n${e.message}`);
            }
        }
    }
    
    // 判斷模式類型
    let mode = 'include-only';
    if (hasInclude && !hasExclude) {
        mode = 'include-only';
    } else if (!hasInclude && hasExclude) {
        mode = 'exclude-only';
    } else if (hasInclude && hasExclude) {
        // 找到第一個包含行的位置
        let firstIncludeIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            let isExcludeCheck = false;
            if (trimmed.startsWith('!') && !trimmed.startsWith('\\!')) {
                isExcludeCheck = true;
            }
            if (!isExcludeCheck) {
                firstIncludeIndex = i;
                break;
            }
        }
        // 檢查包含行之後是否有排除行
        let hasExcludeAfterInclude = false;
        for (let i = firstIncludeIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            let isExcludeCheck = false;
            if (trimmed.startsWith('!') && !trimmed.startsWith('\\!')) {
                isExcludeCheck = true;
            }
            if (isExcludeCheck) {
                hasExcludeAfterInclude = true;
                break;
            }
        }
        mode = hasExcludeAfterInclude ? 'exclude-last' : 'exclude-first';
    }
    
    return {
        includePatterns: includePatterns,
        excludePatterns: excludePatterns,
        mode: mode
    };
}

function patternsToRegexArray(patternsArray) {
    if (!patternsArray || patternsArray.length === 0) return [];
    const regexArray = [];
    for (const pattern of patternsArray) {
        try {
            regexArray.push(new RegExp(pattern));
        } catch (e) {}
    }
    return regexArray;
}

function buildNativeSearchQuery(searchText, fileNamePatterns, isPreset, isBooleanQuery = false) {
    let includePatterns, excludePatterns;
    
    if (isPreset) {
        // 預設模式：需要解析排除模式
        // 将正则数组转换为文本格式再解析
        const patternsText = fileNamePatterns.map(p => p.source).join('\n');
        const parsed = parsePatternsWithExcludes(patternsText);
        includePatterns = parsed.includePatterns;
        excludePatterns = parsed.excludePatterns;
    } else {
        const parsed = parsePatternsWithExcludes(fileNamePatterns);
        includePatterns = parsed.includePatterns;
        excludePatterns = parsed.excludePatterns;
    }
    
    const isRegexContent = isRegexPattern(searchText);
    
    if (includePatterns.length === 0 && excludePatterns.length === 0) {
        return null;
    }

    // 處理包含模式
    const includeParts = [];
    for (const pattern of includePatterns) {
        const patternSource = pattern.source;
        const isPath = patternSource.includes('\\/') || patternSource.includes('/');
        const prefix = isPath ? 'path' : 'file';
        // 括號保護，形成 (file:/pattern/) 或 (path:/pattern/)，避免被空格、特殊字符破壞語法結構
        includeParts.push(`(${prefix}:/${patternSource}/)`);
    }

    // 处理排除模式
    const excludeParts = [];
    for (const pattern of excludePatterns) {
        const patternSource = pattern.source;
        const isPath = patternSource.includes('\\/') || patternSource.includes('/');
        const prefix = isPath ? 'path' : 'file';
        // 括號保護，形成 (-file:/pattern/) 等
        excludeParts.push(`(-${prefix}:/${patternSource}/)`);
    }

    let contentQuery;
    if (isBooleanQuery) {
        // 將布爾表達式轉換為原生語法
        contentQuery = convertBooleanToNative(searchText);
    } else if (isRegexContent) {
        contentQuery = `/${searchText}/`;
    } else {
        contentQuery = `(${searchText})`;
    }

    // 構建查詢 - 排除模式放在括號外面
    let query = `(line:${contentQuery})`;
    
    if (includeParts.length > 0) {
        query = `${query} (${includeParts.join(" OR ")})`;
    }
    
    if (excludeParts.length > 0) {
        query = `${query} ${excludeParts.join(" ")}`;
    }
    
    return query;
}

// ==================== 排序輔助函數 ====================
class ResultSorter {
    constructor(settings) {
        this.settings = settings;
    }
    
    // 解析文件優先級列表（支持正則）
    // 返回數組，每項包含 regex 和 isPathPattern 標誌
    getFilePriorityList() {
        if (!this.settings.filePriority || !Array.isArray(this.settings.filePriority) || this.settings.filePriority.length === 0) {
            return [];
        }
        const regexList = [];
        for (const pattern of this.settings.filePriority) {
            const trimmed = pattern.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                try {
                    // 檢測是否為路徑模式（包含 / 或 \/）
                    const isPathPattern = trimmed.includes('/') || trimmed.includes('\\/');
                    regexList.push({
                        regex: new RegExp(trimmed),
                        isPathPattern: isPathPattern,
                        source: trimmed
                    });
                } catch (e) {
                    console.error(`文件優先級正則錯誤: ${trimmed}`, e);
                }
            }
        }
        return regexList;
    }

    // 規則 A：文件優先級排序
    // 將文件分成「優先文件」和「普通文件」，優先文件按優先級列表順序排列
    applyFilePriority(results, priorityList) {
        if (priorityList.length === 0) {
            // 沒有優先級列表時，所有文件都是普通文件
            return results.map(r => ({ ...r, _isPriority: false }));
        }
        
        // 為每個結果計算文件優先級分數（匹配到的索引，越小越靠前）
        const resultsWithPriority = results.map(result => {
            let priorityScore = Infinity;
            let isPriority = false;
            const filePath = result.file;
            const fileName = filePath.split('/').pop(); // 提取文件名（不含路徑）
            
            for (let i = 0; i < priorityList.length; i++) {
                const item = priorityList[i];
                const regex = item.regex;
                const isPathPattern = item.isPathPattern;
                
                // 根據模式類型選擇匹配目標
                const target = isPathPattern ? filePath : fileName;
                
                if (regex.test(target)) {
                    priorityScore = i;
                    isPriority = true;
                    break;
                }
            }
            return {
                ...result,
                _priorityScore: priorityScore,
                _isPriority: isPriority
            };
        });
        
        // 排序：優先文件排在普通文件前面，優先文件按 priorityScore 排序
        resultsWithPriority.sort((a, b) => {
            // 優先文件排在普通文件前面
            if (a._isPriority !== b._isPriority) {
                return a._isPriority ? -1 : 1;
            }
            // 都是優先文件：按 priorityScore 排序
            if (a._isPriority && b._isPriority) {
                return a._priorityScore - b._priorityScore;
            }
            // 都是普通文件：保持原順序
            return 0;
        });
        
        // 移除臨時屬性（保留 _isPriority 供後續步驟使用）
        return resultsWithPriority.map(r => {
            const { _priorityScore, ...rest } = r;
            return rest;
        });
    }

    // 獲取文件所屬的組（用於組合搜索），按組間優先級返回組名
    // 如果同一文件屬於多個組，返回優先級最高的那個組
    getFileGroup(filePath, groups, groupPriorityList) {
        let bestGroup = null;
        let bestPriority = Infinity;

        for (const [groupName, groupData] of Object.entries(groups)) {
            const groupPatterns = groupData.patterns || [];
            for (const patternStr of groupPatterns) {
                try {
                    const regex = new RegExp(patternStr);
                    if (regex.test(filePath)) {
                        const idx = groupPriorityList.indexOf(groupName);
                        const priority = idx === -1 ? Infinity : idx;
                        if (priority < bestPriority) {
                            bestPriority = priority;
                            bestGroup = groupName;
                        }
                        break;
                    }
                } catch(e) {}
            }
        }
        
        return bestGroup;
    }

    // 規則 C：組間優先級排序
    // 只對普通文件按組間順序排列
    applyGroupPriority(results, groups, groupPriorityList, relevantGroupNames) {
        if (!relevantGroupNames || relevantGroupNames.length === 0) {
            return results;
        }
        
        // 分離優先文件和普通文件（優先文件不再參與 C 規則）
        const priorityFiles = results.filter(r => r._isPriority === true);
        const normalFiles = results.filter(r => r._isPriority !== true);
        
        // 只對普通文件應用組優先級
        const resultsWithGroup = normalFiles.map(result => {
            let groupPriority = Infinity;
            let matchedGroup = null;
            
            // 只檢查當前搜索相關的組
            for (const groupName of relevantGroupNames) {
                const groupData = groups[groupName];
                if (!groupData) continue;
                
                const groupPatterns = groupData.patterns || [];
                let matched = false;
                for (const patternStr of groupPatterns) {
                    try {
                        const regex = new RegExp(patternStr);
                        if (regex.test(result.file)) {
                            matched = true;
                            break;
                        }
                    } catch(e) {}
                }
                
                if (matched) {
                    matchedGroup = groupName;
                    const idx = groupPriorityList.indexOf(groupName);
                    groupPriority = idx === -1 ? Infinity : idx;
                    break;
                }
            }
            
            return {
                ...result,
                _groupPriority: groupPriority,
                _matchedGroup: matchedGroup
            };
        });
        
        // 對普通文件按 groupPriority 排序
        resultsWithGroup.sort((a, b) => {
            if (a._groupPriority !== b._groupPriority) {
                return a._groupPriority - b._groupPriority;
            }
            return 0;
        });
        
        // 移除臨時屬性
        const cleanedNormal = resultsWithGroup.map(r => {
            const { _groupPriority, _matchedGroup, ...rest } = r;
            return rest;
        });
        
        // 優先文件在前，普通文件在後
        return [...priorityFiles, ...cleanedNormal];
    }
    
    // 規則 B：組內模式優先級排序
    // 在每個組內部，按正則模式的順序排序
    applyPatternPriority(results, patternsArray) {
        if (!patternsArray || patternsArray.length === 0) {
            return results;
        }
        
        // 分離優先文件和普通文件（優先文件不再參與 B 規則）
        const priorityFiles = results.filter(r => r._isPriority === true);
        const normalFiles = results.filter(r => r._isPriority !== true);
        
        // 只對普通文件應用模式優先級
        const resultsWithPatternIdx = normalFiles.map(result => {
            let patternIndex = Infinity;
            // 找出這個文件匹配的模式在 patternsArray 中的索引
            for (let i = 0; i < patternsArray.length; i++) {
                const pattern = patternsArray[i];
                if (pattern.test(result.file) || pattern.test(result.file.split('/').pop())) {
                    patternIndex = i;
                    break;
                }
            }
            return {
                ...result,
                _patternIndex: patternIndex
            };
        });
        
        // 對普通文件按 patternIndex 排序（Infinity 排在最後）
        resultsWithPatternIdx.sort((a, b) => {
            if (a._patternIndex !== b._patternIndex) {
                return a._patternIndex - b._patternIndex;
            }
            return 0;
        });
        
        // 移除臨時屬性
        const cleanedNormal = resultsWithPatternIdx.map(r => {
            const { _patternIndex, ...rest } = r;
            return rest;
        });
        
        // 優先文件在前，普通文件在後
        return [...priorityFiles, ...cleanedNormal];
    }

    // 主排序方法
    // searchContext: { type, patternsForB, needGroupPriority, groupPriorityList, groupNamesForC, allGroups }
    sortResults(results, searchContext) {
        if (!results || results.length === 0) return results;
        if (!this.settings.enableSorting) return results;
        
        let sortedResults = [...results];
        
        // 獲取文件優先級列表（規則 A）
        const priorityList = this.getFilePriorityList();
        
        // 步驟1：規則 A - 文件優先級（全局，永遠執行）
        // 將優先文件按優先級列表順序排好，普通文件跟在後面
        // 同時會添加 _isPriority 標記，供後續步驟識別哪些是優先文件
        sortedResults = this.applyFilePriority(sortedResults, priorityList);
        
        // 步驟2：規則 C - 組間優先級（僅當需要時）
        // 注意：applyGroupPriority 內部會過濾掉優先文件，只處理普通文件
        if (searchContext.needGroupPriority && searchContext.groupNamesForC && searchContext.groupNamesForC.length > 0) {
            sortedResults = this.applyGroupPriority(
                sortedResults, 
                searchContext.allGroups, 
                searchContext.groupPriorityList, 
                searchContext.groupNamesForC
            );
        }
        
        // 步驟3：規則 B - 組內模式優先級
        // 注意：applyPatternPriority 內部會過濾掉優先文件，只處理普通文件
        if (searchContext.patternsForB && searchContext.patternsForB.length > 0) {
            sortedResults = this.applyPatternPriority(sortedResults, searchContext.patternsForB);
        }
        
        // 清理 _isPriority 標記（避免污染最終結果）
        return sortedResults.map(r => {
            const { _isPriority, ...rest } = r;
            return rest;
        });
    }
}

// ==================== 結果視圖（右側邊欄）- 支援高亮和精準跳轉 ====================
function highlightText(text, searchText, isRegex, pluginSettings) {
    if (!searchText) return text;
    const keywordBg = pluginSettings?.colors?.keywordBg || "var(--text-highlight-bg)";
    try {
        let regex;
        if (isRegex) {
            regex = new RegExp(`(${searchText})`, 'gi');
        } else {
            regex = new RegExp(`(${searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        }
        return text.replace(regex, `<span style="background: ${keywordBg}; color: inherit;">$1</span>`); // 搜索關鍵詞 匹配背景
    } catch (e) {
        return text;
    }
}

// ==================== 結果視圖（右側邊欄） ====================
class SearchResultView extends ItemView {
    /**
     * 使用正則表達式高亮文本
     * @param {string} text - 原始文本
     * @param {RegExp} regex - 高亮用正則（全局模式）
     * @returns {string} 高亮後的 HTML
     */
    highlightTextWithRegex(text, regex) {
        if (!text || !regex) return text;
        const keywordBg = this.plugin.settings?.colors?.keywordBg || "var(--text-highlight-bg)";
        try {
            // 確保正則是全局模式
            let finalRegex = regex;
            if (!finalRegex.flags.includes('g')) {
                finalRegex = new RegExp(finalRegex.source, finalRegex.flags + 'g');
            }
            return text.replace(finalRegex, (match) => {
                return `<span style="background: ${keywordBg}; color: inherit;">${this.escapeHtml(match)}</span>`;
            });
        } catch (e) {
            console.error("高亮正則錯誤:", e);
            return text;
        }
    }
    
    /**
     * 轉義 HTML 特殊字符
     * @param {string} str - 原始字符串
     * @returns {string} 轉義後的字符串
     */
    escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentSearchText = "";
        this.currentResults = [];
        this.isRegexContent = false;
        this.isBooleanQuery = false;
        this.fileContents = new Map();
        this.statsText = "";
        this.currentPatterns = []; // 當前搜索範圍對應的模式數組
        this.currentRangeDisplay = ""; // 當前搜索的範圍顯示文字
        this.currentPatternsText = ""; // 當前搜索的原始模式文本（用於保存歷史）
        this.currentIsPreset = false; // 當前是否為預設範圍搜索
        this.currentRangeRef = null; // 當前搜索的範圍引用（用於重新打開面板）
        this.enableDiacriticIgnore = false;
        this.enableHtmlTagIgnore = false;
        this.highlightRegex = null;
        
        // 顯示模式管理
        this.globalMode = this.plugin.settings.defaultDisplayMode; // 'A' 或 'B'
        this.itemModes = new Map(); // key: "filePath|index" -> mode ('A', 'B', 'C')
        // 記錄每個文件的三模式按鈕組的展開狀態
        this.fileModeButtonsVisible = new Map(); // key: filePath -> boolean
        
        // 動態測量
        this.charWidth = null;
        this.panelWidth = null;
        this.resizeObserver = null;
        this.measureElement = null;
        this.isRendering = false;
        
        // 排序器
        this.sorter = new ResultSorter(this.plugin.settings);

        // 鍵盤導航屬性
        this.focusedItemIndex = -1;           // 當前聚焦的條目索引
        this.focusableItems = [];              // 所有可聚焦條目的數組
        this.keyboardHandler = null;           // 鍵盤事件處理器的引用
        
        // 歷史導航屬性
        this.historyLongPressTimer = null;     // 長按計時器
        this.isLongPressTriggered = false;     // 是否已觸發長按
    }

    getViewType() {
        return VIEW_TYPE_SEARCH_RESULT;
    }

    getDisplayText() {
        return "custom-search結果";
    }

    getIcon() {
        return "book-open";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.style.padding = "10px";
        container.style.overflowY = "auto";
        container.style.height = "100%";
        
        // 創建測量元素
        this.setupMeasureElement();
        
        // 監聽面板寬度變化
        this.setupResizeObserver(container);
        
        if (this.currentResults.length === 0) {
            const emptyDiv = container.createEl("div", {
                attr: { style: "color: var(--text-muted); text-align: center; margin-top: 20px;" }
            });
            emptyDiv.createEl("span", { text: "暫無搜索結果。請選中文本後執行「custom-search」命令。" });
            
            // 檢查是否有歷史記錄
            const history = this.plugin.settings.searchHistory;
            if (history && history.items && history.items.length > 0) {
                const linkSpan = emptyDiv.createEl("div", { text: "（" });
                const historyLink = linkSpan.createEl("a", {
                    text: "查看最近一次的搜索",
                    attr: { style: "color: var(--text-accent); cursor: pointer; text-decoration: underline;" }
                });
                historyLink.onclick = async () => {
                    await this.loadHistoryItem(0);
                };
                linkSpan.createEl("span", { text: "）" });
            }
        } else {
            await this.renderResults(container);
        }

    // 設置鍵盤導航
    this.setupKeyboardNavigation();
    }

    setupMeasureElement() {
        this.measureElement = document.createElement('div');
        this.measureElement.style.cssText = `
            position: fixed;
            visibility: hidden;
            pointer-events: none;
            font-family: var(--font-monospace);
            font-size: 12px;
            line-height: 1.4;
            white-space: nowrap;
        `;
        document.body.appendChild(this.measureElement);
    }

    setupResizeObserver(container) {
        if (this.resizeObserver) this.resizeObserver.disconnect();
        this.resizeObserver = new ResizeObserver(() => {
            this.calculateCharWidth(container);
        });
        this.resizeObserver.observe(container);
        // 初始計算
        setTimeout(() => this.calculateCharWidth(container), 100);
    }
    
    calculateCharWidth(container) {
        if (!container || !this.measureElement) return;
        const panelRect = container.getBoundingClientRect();
        if (panelRect.width === this.panelWidth) return;
        this.panelWidth = panelRect.width;
        
        // 測量一個中文字符的寬度
        this.measureElement.textContent = '中';
        const charRect = this.measureElement.getBoundingClientRect();
        this.charWidth = charRect.width;
        
        if (this.panelWidth > 0 && this.charWidth > 0) {
            // 重新渲染以應用新的截取
            this.refreshDisplay();
        }
    }

    async onClose() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.measureElement) {
            this.measureElement.remove();
        }

        // 移除鍵盤事件監聽
        if (this.keyboardHandler) {
            const container = this.containerEl.children[1];
            if (container) {
                container.removeEventListener('keydown', this.keyboardHandler);
            }
            this.keyboardHandler = null;
        }

        // 清理懸浮按鈕的事件監聽器
        if (this._cleanupFns) {
            for (const cleanup of this._cleanupFns) {
                try {
                    cleanup();
                } catch(e) {}
            }
            this._cleanupFns = [];
        }

        // 清理可能殘留的歷史面板
        const existingPanel = document.querySelector('.custom-search-history-panel');
        if (existingPanel) {
            if (existingPanel._cleanup) {
                existingPanel._cleanup();
            }
            existingPanel.remove();
        }
    }

    async refreshDisplay() {
        if (this.isRendering) return;
        const container = this.containerEl.children[1];
        if (container && this.currentResults.length > 0) {
            await this.renderResults(container);
            // 重新渲染後更新可聚焦項目
            this.updateFocusableItems();
        }
    }

    // 截取行內容（狀態A專用）- 只處理純文本
    truncateLine(lineContent, keyword, isRegex, highlightRegex = null) {
        if (!this.charWidth || !this.panelWidth || this.panelWidth <= 0) {
            return lineContent;
        }

        // 獲取插件的字符寬度緩存
        const compensatedSet = this.plugin.compensatedCharSet;
        const zeroWidthSet = this.plugin.zeroWidthCharSet;

        // 輔助函數：判斷是否為全角字符
        const isFullwidth = (char) => {
            const code = char.charCodeAt(0);
            // 常見全角字符範圍
            return (code >= 0x4e00 && code <= 0x9fff) ||  // 中日韓統一表意文字
                   (code >= 0xff00 && code <= 0xffef) ||  // 全角 ASCII
                   (code >= 0x3000 && code <= 0x303f);     // 中日韓符號
        };

        // 輔助函數：判斷是否為窄字符（需要折算0.2單位）
        const isCompensatedChar = (char) => compensatedSet.has(char.charCodeAt(0));

        // 輔助函數：判斷是否為零寬度字符（完全跳過）
        const isZeroWidthCombining = (char) => zeroWidthSet.has(char.charCodeAt(0));

        // 計算字符串的單位長度
        // 參數: str - 字符串, skipZeroWidth - 是否跳過零寬度字符, skipCompensated - 是否跳過窄字符
        const getUnitLength = (str, skipZeroWidth = true, skipCompensated = true) => {
            let units = 0;
            for (const char of str) {
                if (skipZeroWidth && isZeroWidthCombining(char)) {
                    continue;  // 跳過零寬度疊加字符
                }
                if (skipCompensated && isCompensatedChar(char)) {
                    continue;  // 跳過窄字符（後續單獨折算）
                }
                units += isFullwidth(char) ? 2 : 1;
            }
            return units;
        };
        
        // 根據單位長度截取字符串
        const truncateByUnits = (str, maxUnits) => {
            let units = 0;
            let result = '';
            for (const char of str) {
                // 零寬度疊加字符：直接保留，不計入長度
                if (isZeroWidthCombining(char)) {
                    result += char;
                    continue;
                }
                // 窄字符：直接保留，不計入長度（後續折算）
                if (isCompensatedChar(char)) {
                    result += char;
                    continue;
                }
                const charUnits = isFullwidth(char) ? 2 : 1;
                if (units + charUnits > maxUnits) break;
                units += charUnits;
                result += char;
            }
            return result;
        };
        
        // 修正：半角字符寬度是全角的一半，所以要乘以 2
        const availableUnits = Math.floor(this.panelWidth / this.charWidth * 2) - 4;
        if (availableUnits <= 0) return lineContent;
        
        // 找到關鍵字位置 - 優先使用 highlightRegex
        let keywordStart = -1;
        let keywordEnd = -1;
        let keywordUnits = 0;

        if (highlightRegex) {
            // 使用高亮正則找到第一個匹配的位置
            const match = highlightRegex.exec(lineContent);
            if (match) {
                keywordStart = match.index;
                keywordEnd = keywordStart + match[0].length;
                // 計算關鍵字單位長度時也需要跳過窄字符
                keywordUnits = getUnitLength(match[0], true, true);
            }
            // 重置正則的 lastIndex
            highlightRegex.lastIndex = 0;
        } else if (isRegex) {
            try {
                const regex = new RegExp(keyword);
                const match = regex.exec(lineContent);
                if (match) {
                    keywordStart = match.index;
                    keywordEnd = keywordStart + match[0].length;
                    keywordUnits = getUnitLength(match[0], true, true);
                }
            } catch (e) {}
        } else {
            keywordStart = lineContent.indexOf(keyword);
            if (keywordStart !== -1) {
                keywordEnd = keywordStart + keyword.length;
                keywordUnits = getUnitLength(keyword, true, true);
            }
        }
        
        // 計算整行的單位長度（跳過窄字符）
        const totalUnits = getUnitLength(lineContent, true, true);
        
        if (keywordStart === -1 || totalUnits <= availableUnits) {
            return lineContent;
        }

        // 計算關鍵字前的單位數（跳過窄字符）
        const beforeKeyword = lineContent.substring(0, keywordStart);
        const beforeUnits = getUnitLength(beforeKeyword, true, true);
        
        // 計算關鍵字後的單位數（跳過窄字符）
        const afterKeyword = lineContent.substring(keywordEnd);
        const afterUnits = getUnitLength(afterKeyword, true, true);
        
        // 決定兩邊各取多少單位
        const remainingUnits = availableUnits - keywordUnits;
        let leftUnits = Math.floor(remainingUnits / 2);
        let rightUnits = remainingUnits - leftUnits;
        
        // 調整邊界
        if (beforeUnits < leftUnits) {
            rightUnits += leftUnits - beforeUnits;
            leftUnits = beforeUnits;
        }
        if (afterUnits < rightUnits) {
            leftUnits += rightUnits - afterUnits;
            rightUnits = afterUnits;
        }
        
        // 截取左邊（從 keywordStart 向左，跳過窄字符）
        let leftPart = '';
        let units = 0;
        for (let i = keywordStart - 1; i >= 0; i--) {
            const char = lineContent[i];
            // 零寬度疊加字符：直接添加，不計入長度
            if (isZeroWidthCombining(char)) {
                leftPart = char + leftPart;
                continue;
            }
            // 窄字符：直接添加，不計入長度
            if (isCompensatedChar(char)) {
                leftPart = char + leftPart;
                continue;
            }
            const charUnits = isFullwidth(char) ? 2 : 1;
            if (units + charUnits > leftUnits) break;
            leftPart = char + leftPart;
            units += charUnits;
        }
        
        // 截取右邊（從 keywordEnd 向右，跳過窄字符）
        let rightPart = '';
        units = 0;
        for (let i = keywordEnd; i < lineContent.length; i++) {
            const char = lineContent[i];
            // 零寬度疊加字符：直接添加，不計入長度
            if (isZeroWidthCombining(char)) {
                rightPart += char;
                continue;
            }
            // 窄字符：直接添加，不計入長度
            if (isCompensatedChar(char)) {
                rightPart += char;
                continue;
            }
            const charUnits = isFullwidth(char) ? 2 : 1;
            if (units + charUnits > rightUnits) break;
            rightPart += char;
            units += charUnits;
        }
        
        // 構建截取結果
        let result = leftPart + lineContent.substring(keywordStart, keywordEnd) + rightPart;
        
        // 統計結果中的窄字符數量，折算實際寬度（疊加字符不折算寬度）
        let compensatedCount = 0;
        for (const char of result) {
            if (isCompensatedChar(char)) {
                compensatedCount++;
            }
        }
        
        // 每個窄字符折算為 0.2 單位
        const compensatedUnits = compensatedCount * 0.2;
        if (compensatedUnits > 0) {
            // 如果窄字符佔用了額外空間，需要從兩端預留
            // 從左右兩端各減去一半的窄字符寬度
            const halfCompensatedUnits = Math.ceil(compensatedUnits / 2);
            
            // 重新截取左邊（減少 leftUnits 來預留空間）
            let adjustedLeftUnits = Math.max(0, leftUnits - halfCompensatedUnits);
            leftPart = '';
            units = 0;
            for (let i = keywordStart - 1; i >= 0; i--) {
                const char = lineContent[i];
                if (isZeroWidthCombining(char)) {
                    leftPart = char + leftPart;
                    continue;
                }
                if (isCompensatedChar(char)) {
                    leftPart = char + leftPart;
                    continue;
                }
                const charUnits = isFullwidth(char) ? 2 : 1;
                if (units + charUnits > adjustedLeftUnits) break;
                leftPart = char + leftPart;
                units += charUnits;
            }
            
            // 重新截取右邊（減少 rightUnits 來預留空間）
            let adjustedRightUnits = Math.max(0, rightUnits - halfCompensatedUnits);
            rightPart = '';
            units = 0;
            for (let i = keywordEnd; i < lineContent.length; i++) {
                const char = lineContent[i];
                if (isZeroWidthCombining(char)) {
                    rightPart += char;
                    continue;
                }
                if (isCompensatedChar(char)) {
                    rightPart += char;
                    continue;
                }
                const charUnits = isFullwidth(char) ? 2 : 1;
                if (units + charUnits > adjustedRightUnits) break;
                rightPart += char;
                units += charUnits;
            }
            
            // 重新構建結果
            result = leftPart + lineContent.substring(keywordStart, keywordEnd) + rightPart;
        }
        
        return result;
    }

    // 轉義腳注行
    escapeFootnoteLine(line) {
        if (typeof line !== 'string') return line;
        if (/^\s*\[\^?[^\]\[\s]+?\]:/.test(line)) {
            return '\\' + line;
        }
        return line;
    }

    // 處理行內容中的代碼塊，讓關鍵字逃出反引號以便高亮(BC模式)
    escapeCodeBlockForHighlight(line, keyword) {
        if (!line || !keyword) return line;
        
        // 找出所有代碼塊的內容
        const codeBlocks = [];
        const backtickRegex = /`([^`]*)`/g;
        let match;
        
        while ((match = backtickRegex.exec(line)) !== null) {
            codeBlocks.push({
                content: match[1],
                start: match.index,
                end: match.index + match[0].length
            });
        }
        
        // 檢查關鍵字是否在任何代碼塊內
        let keywordInCodeBlock = false;
        const keywordIndex = line.indexOf(keyword);
        
        for (const block of codeBlocks) {
            if (keywordIndex >= block.start && keywordIndex < block.end) {
                keywordInCodeBlock = true;
                break;
            }
        }
        
        // 只有在代碼塊內才處理
        if (keywordInCodeBlock) {
            const escaped = line.replace(keyword, `\`${keyword}\``);
            return escaped.replace(/``/g, '');
        }
        
        return line;
    }

    processCodeBlockForHighlight(line, searchText, isRegex) {
        if (!line || !searchText) return line;
        
        // 提取關鍵字實際匹配的字符串(正則模式)
        if (isRegex) {
            try {
                const regex = new RegExp(searchText);
                const match = regex.exec(line);
                if (match && match[0]) {
                    return this.escapeCodeBlockForHighlight(line, match[0]);
                }
            } catch (e) {
                return line;
            }
        } else {
            return this.escapeCodeBlockForHighlight(line, searchText);
        }
        
        return line;
    }

    // 處理行內容
    getContextLines(fileContent, lineNumber, searchText, isRegex, mode, highlightRegex = null) {
        const lines = fileContent.split('\n');
        const currentLineIdx = lineNumber - 1;
        
        if (mode === 'A') {
            let lineContent = lines[currentLineIdx] || "";
            // 轉義腳注引用行
            lineContent = this.escapeFootnoteLine(lineContent);
            // A模式：直接刪除所有反引號
            lineContent = lineContent.replace(/`/g, '');
            // 截取和渲染
            const truncatedText = this.truncateLine(lineContent, searchText, isRegex, highlightRegex);
            // 使用 highlightRegex 進行高亮
            let highlighted;
            if (highlightRegex) {
                highlighted = this.highlightTextWithRegex(truncatedText, highlightRegex);
            } else {
                highlighted = highlightText(truncatedText, searchText, isRegex, this.plugin.settings);
            }
            return {
                type: 'A',
                content: highlighted,
                isMatchLine: true
            };
        } else {
            const startLine = Math.max(0, lineNumber - 2);
            const endLine = Math.min(lines.length, lineNumber + 1);
            const result = [];
            for (let i = startLine; i < endLine; i++) {
                let lineContent = lines[i];
                const isMatchLine = (i + 1 === lineNumber);
                // 轉義腳注引用行
                lineContent = this.escapeFootnoteLine(lineContent);
                if (isMatchLine) {
                    // 匹配行：處理代碼塊 → 高亮
                    lineContent = this.processCodeBlockForHighlight(lineContent, searchText, isRegex);
                    // 使用 highlightRegex 進行高亮
                    if (highlightRegex) {
                        lineContent = this.highlightTextWithRegex(lineContent, highlightRegex);
                    } else if (searchText) {
                        lineContent = highlightText(lineContent, searchText, isRegex, this.plugin.settings);
                    }
                }
                
                result.push({
                    content: lineContent,
                    isMatchLine: isMatchLine
                });
            }
            return {
                type: mode,
                lines: result
            };
        }
    }

    getLineDisplayStyle(mode) {
        const colors = this.plugin.settings.colors || DEFAULT_SETTINGS.colors;
        const modeAColor = colors.modeA;
        const modeBColor = colors.modeB;
        
        if (mode === 'A') {
            return {
                containerStyle: `margin: 0px -9px 4px -3px; font-size: 12px; font-family: monospace; padding: 4px 0px; border-radius: 4px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.2s; white-space: nowrap; overflow-x: hidden; scrollbar-width: thin; display: flex; align-items: flex-start; gap: 0px;`,
                contentStyle: `white-space: nowrap;`,
                modeColor: modeAColor
            };
        } else if (mode === 'B') {
            return {
                containerStyle: `margin: 0px -9px 8px -3px; font-size: 12px; font-family: monospace; padding: 4px 0px; border-radius: 4px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.2s; max-height: 80px; overflow-y: auto; display: flex; align-items: flex-start; gap: 0px;`,
                contentStyle: `white-space: pre-wrap; word-break: break-all;`,
                modeColor: modeBColor
            };
        } else { // mode === 'C'
            return {
                containerStyle: `margin: 0px -9px 8px -3px; font-size: 12px; font-family: monospace; padding: 4px 0px; border-radius: 4px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.2s; overflow-y: visible; display: flex; align-items: flex-start; gap: 0px;`,
                contentStyle: `white-space: pre-wrap; word-break: break-all;`,
                modeColor: colors.modeC
            };
        }
    }

    async renderResults(container) {
        if (this.isRendering) return;
        this.isRendering = true;

        container.empty();
        
        // 容器為 flex 佈局，不滾動
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.height = "100%";
        container.style.overflow = "hidden";  // 容器本身不滾動
        container.style.padding = "0px";

        // ===== 固定頭部 - 按鈕 (導航，A、B、C，Top) =====
        const fixedHeader = container.createEl("div", { 
            attr: { 
                style: "flex-shrink: 0; background: var(--background-primary); z-index: 100; padding: 4px 8px 4px 8px; border-bottom: 1px solid var(--background-modifier-border);" 
            } 
        });

        // 按鈕行
        const buttonRow = fixedHeader.createEl("div", { 
            attr: { style: "display: flex; align-items: center; gap: 12px;" } 
        });

        // 添加歷史導航按鈕組（← → 箭頭）
        this.setupHistoryNavButtons(buttonRow);

        // 替換原來的 span，改成用 setIcon 或 SVG
        let globeSpan = buttonRow.createSpan({ attr: { style: "display: inline-flex; align-items: center;", title: "全局模式：A, B, C" } });
        globeSpan.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>`;

        const modeBtnGroup = buttonRow.createEl("div", {
            attr: { style: "display: flex; gap: 6px;" } 
        });

        // 全局模式名稱，包含 C 模式
        const modeNames = { A: "A", B: "B", C: "C" };

        // 遍歷 A、B、C 三個模式
        for (const key of ['A', 'B', 'C']) {
            const isActive = (this.globalMode === key);
            const colors = this.plugin.settings.colors || DEFAULT_SETTINGS.colors;
            const modeColors = { A: colors.modeA, B: colors.modeB, C: colors.modeC };
            const activeBorderColor = colors.activeBorder || "#000000";
            // 設置按鈕的懸停提示文字
            let tooltipText = "";
            if (key === 'A') {
                tooltipText = "單行模式";
            } else if (key === 'B') {
                tooltipText = "三行，超出滾動";
            } else if (key === 'C') {
                tooltipText = "三行展開";
            }

            // 獲取按鈕文字顏色（使用已配置的序號文字顏色）
            const btnTextColors = {
                A: colors.modeANumberColor || "rgba(28, 27, 34, 0.85)",
                B: colors.modeBNumberColor || "rgba(28, 27, 34, 0.85)",
                C: colors.modeCNumberColor || "rgba(255, 255, 255, 0.9)"
            };
            const textColor = btnTextColors[key];

            const btn = modeBtnGroup.createEl("button", {
                text: modeNames[key],
                attr: { 
                    title: tooltipText,
                    style: `padding: 2px 8px; font-size: 11px; border-radius: 4px; cursor: pointer; background: ${modeColors[key]}; color: ${textColor}; border: ${isActive ? `2px solid ${activeBorderColor}` : '1px solid var(--background-modifier-border)'};`
                }
            });
            btn.onclick = async () => {
                this.globalMode = key;
                this.itemModes.clear();
                this.plugin.settings.defaultDisplayMode = key;
                await this.plugin.saveSettings();
                this.refreshDisplay();
            };
        }

        // Top 按鈕
        const topBtn = buttonRow.createEl("button", {
            attr: { 
                style: "padding: 2px 4px; font-size: 11px; color: rgba(150, 150, 150, 50); border-radius: 4px; cursor: pointer; background: rgba(251, 251, 251, 0); border: 1px solid rgba(251, 251, 251, 0); margin-left: auto; display: inline-flex; align-items: center; gap: 2px;"
            }
        });

        // 添加向上箭頭 SVG
        topBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"></line>
                <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
            <span>Top</span>`;


        // ===== 滾動區域（獨立滾動）=====
        const scrollArea = container.createEl("div", { 
            attr: { 
                style: "flex: 1; overflow-y: auto; overflow-x: hidden; margin-top: 12px; padding: 10px;"
            } 
        });
        
        // Top 按鈕的點擊事件（滾動滾動區域）
        topBtn.onclick = () => {
            scrollArea.scrollTo({ top: 0, behavior: 'smooth' });
        };

        // ===== 以下內容全部放在滾動區域中 =====

        // 搜索標題 - 使用更柔和的顏色
        let modeHint = '';
        if (this.isRegexContent) {
            modeHint = ' (正則模式)';
        } else if (this.isBooleanQuery) {
            modeHint = ' (布爾模式)';
        }

        let titleDiv = scrollArea.createDiv({ attr: { style: "display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 16px; margin-bottom: 8px;" } });
        titleDiv.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
            <span>搜索結果：「${this.currentSearchText}」${modeHint}</span>`;

        // 統計信息 - 使用 muted 顏色（更淡），添加重新搜索按鈕
        let statsDiv = scrollArea.createDiv({ attr: { style: "display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--text-muted); margin-bottom: 6px;" } });
        
        // 左側：統計信息
        const statsLeft = statsDiv.createDiv({ attr: { style: "display: flex; align-items: center; gap: 6px;" } });
        statsLeft.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>
            <span>${this.statsText}(匹配${new Set(this.currentResults.map(r => r.file)).size})個，${this.currentResults.length}處</span>`;
        
        // 右側：重新搜索按鈕（打開搜索面板，使用當前搜索方式）
        const reopenBtn = statsDiv.createEl("button", {
            attr: {
                style: "padding: 2px 8px; font-size: 10px; border-radius: 4px; cursor: pointer; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); color: var(--text-muted); display: inline-flex; align-items: center; gap: 4px;",
                title: "使用當前搜索方式重新打開面板"
            }
        });
        reopenBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
            <span>重新搜索</span>
        `;

            // 綁定重新搜索按鈕事件
        reopenBtn.onclick = async () => {
            // 關閉可能打開的歷史面板
            this.closeHistoryPanel();
            
            // 構建當前搜索的歷史條目對象（用於恢復對話框）
            const currentHistoryItem = {
                searchText: this.currentSearchText,
                isRegex: this.isRegexContent,
                isBooleanQuery: this.isBooleanQuery || false,
                enableDiacriticIgnore: this.enableDiacriticIgnore || false,
                enableHtmlTagIgnore: this.enableHtmlTagIgnore || false,
                rangeRef: this.currentRangeRef,
                timestamp: Date.now()
            };
            
            // 檢查主對話框是否存在
            const existingDialog = this.plugin.currentModal;
            const dialogExists = existingDialog && document.body.contains(existingDialog);
            
            if (dialogExists) {
                // 對話框已存在：提取引用並更新內容
                const dialogRefs = this.extractDialogRefs(existingDialog);
                if (dialogRefs) {
                    const success = await this.plugin.updateCurrentDialogWithHistory(currentHistoryItem, dialogRefs);
                    if (success) {
                        // 聚焦到對話框
                        existingDialog.focus();
                        new Notice("✅ 已載入當前搜索設置到對話框");
                    } else {
                        new Notice("⚠️ 更新對話框失敗，將打開新對話框");
                        // 降級：打開新對話框
                        const result = await this.plugin.showSearchModeDialog(
                            this.currentSearchText,
                            this.currentPatternsText,
                            this.currentPatternsText.includes('\n'),
                            this.currentRangeRef,
                            this.isBooleanQuery || false,
                            this.enableDiacriticIgnore || false,
                            this.enableHtmlTagIgnore || false
                        );
                        if (result) {
                            await this.plugin.executeSearchFromDialogResult(result, { skipHistorySave: false });
                        }
                    }
                } else {
                    new Notice("⚠️ 無法獲取對話框引用，將打開新對話框");
                    // 降級：打開新對話框
                    const result = await this.plugin.showSearchModeDialog(
                        this.currentSearchText,
                        this.currentPatternsText,
                        this.currentPatternsText.includes('\n'),
                        this.currentRangeRef,
                        this.isBooleanQuery || false,
                        this.enableDiacriticIgnore || false,
                        this.enableHtmlTagIgnore || false
                    );
                    if (result) {
                        await this.plugin.executeSearchFromDialogResult(result, { skipHistorySave: false });
                    }
                }
                return;
            }
            
            // 對話框不存在：打開新對話框並恢復狀態
            const searchTextToPass = this.currentSearchText;
            const patternsToPass = this.currentPatternsText;
            const isPresetToPass = this.currentIsPreset;
            
            // 判斷是否為預定範圍：如果是預定範圍，不填充文件名編輯區；否則填充
            const isDefaultRange = (this.currentRangeRef && this.currentRangeRef.type === "default");
            let previousFileNameToPass = "";
            let prefillAsMultiLine = false;
            
            if (!isDefaultRange) {
                previousFileNameToPass = patternsToPass;
                // 如果 patternsText 包含換行符（多行模式），則需要以多行方式填充
                prefillAsMultiLine = patternsToPass.includes('\n');
            }
            
            // 調用插件的搜索面板方法，傳入當前的 rangeRef、isBooleanQuery、enableDiacriticIgnore 用於恢復狀態
            const result = await this.plugin.showSearchModeDialog(
                searchTextToPass,
                previousFileNameToPass,
                prefillAsMultiLine,
                this.currentRangeRef,
                this.isBooleanQuery || false,
                this.enableDiacriticIgnore || false,
                this.enableHtmlTagIgnore || false
            );
            
            if (!result) return;
            
            // 根據用戶選擇執行搜索
            await this.plugin.executeSearchFromDialogResult(result, { skipHistorySave: false });
        };

        // 分組顯示結果
        const groupedResults = {};
        for (const result of this.currentResults) {
            if (!groupedResults[result.file]) {
                groupedResults[result.file] = [];
            }
            groupedResults[result.file].push(result);
        }

        // 預加載所有文件內容
        const fileContentsMap = new Map();
        for (const file of Object.keys(groupedResults)) {
            const fileObj = this.app.vault.getAbstractFileByPath(file);
            if (fileObj instanceof TFile) {
                const content = await this.app.vault.read(fileObj);
                fileContentsMap.set(file, content);
            }
        }

        // 內容區域
        const contentArea = scrollArea.createEl("div", { attr: { style: "flex: 1;" } });

        // 全局條目索引計數器
        let globalItemIndex = 0;

        // 渲染每個文件
        for (const [file, items] of Object.entries(groupedResults)) {
            const fileSection = contentArea.createEl("div", { attr: { style: "margin-top: 5px; margin-bottom: 0px;" } });
            
            const fileHeader = fileSection.createEl("div", { 
                attr: { style: "display: flex; align-items: center; gap: 4px; margin-bottom: 4px; padding: 4px 0; border-bottom: 1px solid var(--background-modifier-border); flex-wrap: wrap;" } 
            });
            // 提取文件名（不含路徑和擴展名）
            const fileName = file.split('/').pop().replace(/\.md$/, '');
            const fileNameColor = this.plugin.settings.colors?.fileName || "var(--text-accent)";
            fileHeader.createEl("h4", { text: `📄 ${fileName}`, attr: { style: `margin: 0; font-size: 13px; color: ${fileNameColor};`, title: file } });

            // 先獲取文件內容
            const fileContent = fileContentsMap.get(file);

            // 文件級別的模式控制按鈕（在獲取 fileContent 之後調用）
            await this.createFileModeControls(file, items, fileContent, fileSection, fileHeader);

            /*/ 添加提示文字（替換原來的按鈕組）
            const tipSpan = fileHeader.createEl("span", { 
                text: "💡 左側序號：顯示切換", 
                attr: { style: "font-size: 10px; color: var(--text-muted); margin-left: auto;" } 
            });*/

            // 渲染每個條目的內容 - 傳入全局起始索引
            await this.renderFileItems(fileSection, fileHeader, fileContent, items, file, globalItemIndex);
            globalItemIndex += items.length;
        }

        this.isRendering = false;
        // 更新可聚焦項目列表
        this.updateFocusableItems();
        this.containerEl.children[1].focus();
    }

    async refreshFileSection(file, items, fileContent, fileSection, fileHeader) {
        // 保存當前滾動位置
        const scrollContainer = this.containerEl.children[1];
        const scrollTop = scrollContainer.scrollTop;
        
        // 移除該文件區域的所有內容（除了文件頭）
        const children = Array.from(fileSection.children);
        for (const child of children) {
            if (child !== fileHeader) {
                child.remove();
            }
        }

        // 重新渲染條目
        await this.renderFileItems(fileSection, fileHeader, fileContent, items, file);

        // 恢复滾動位置
        scrollContainer.scrollTop = scrollTop;
        // 重新渲染後更新可聚焦項目
        this.updateFocusableItems();
    }

    // 創建文件級別的模式控制按鈕（懸浮展開版 - 向左絕對定位）
    createFileModeControls(file, items, fileContent, fileSection, fileHeader) {
        const controlContainer = fileHeader.createEl("div", {
            attr: { style: "display: inline-flex; align-items: center; gap: 4px; margin-left: auto; position: relative;" }  // 添加 position: relative
        });

        // 獲取顏色配置
        const colors = this.plugin.settings.colors || DEFAULT_SETTINGS.colors;
        const modeColors = { A: colors.modeA, B: colors.modeB, C: colors.modeC };

        // 創建一個包裝容器，用於檢測鼠標離開整個區域
        const hoverZone = controlContainer.createEl("div", {
            attr: { style: "display: inline-flex; align-items: center; gap: 4px; position: relative;" }
        });

        // 模式按鈕容器（初始隱藏）- 改為絕對定位向左展開
        const modeBtnContainer = hoverZone.createEl("div", {
            attr: { style: `position: absolute; right: 100%; top: 50%; transform: translateY(-50%); display: none; gap: 2px; background: rgba(255, 255, 255, 0.75); padding: 1px 4px; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.15); border: 1px solid var(--background-modifier-border); z-index: 100;` }
        });

        // 創建 A、B、C 三個模式按鈕
        const modeNames = { A: "A", B: "B", C: "C" };
        for (const modeKey of ['A', 'B', 'C']) {
            // 獲取按鈕文字顏色（使用已配置的序號文字顏色）
            const btnTextColors = {
                A: this.plugin.settings.colors?.modeANumberColor || "rgba(28, 27, 34, 0.85)",
                B: this.plugin.settings.colors?.modeBNumberColor || "rgba(28, 27, 34, 0.85)",
                C: this.plugin.settings.colors?.modeCNumberColor || "rgba(255, 255, 255, 0.9)"
            };
            const textColor = btnTextColors[modeKey];
            
            const modeBtn = modeBtnContainer.createEl("button", {
                text: modeNames[modeKey],
                attr: { 
                    style: `padding: 1px 4px; font-size: 11px; border-radius: 4px; cursor: pointer; background: ${modeColors[modeKey]}; color: ${textColor}; border: 1px solid var(--background-modifier-border); line-height: 1;`
                }
            });
            modeBtn.onclick = async (e) => {
                e.stopPropagation();
                await this.setAllItemsModeForFile(file, items, fileContent, fileSection, fileHeader, modeKey);
            };
        }

        // « 主控制按鈕（固定在右側）
        const toggleBtn = hoverZone.createEl("button", {
            text: "«",
            attr: { 
                style: "padding: 2px 4px; font-size: 11px; border-radius: 4px; cursor: pointer; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); line-height: 1; position: relative; z-index: 101;"
            }
        });
        
        // 計時器變量
        let hoverTimer = null;
        let hideTimer = null;
        
        // 展開功能
        const showButtons = () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            if (hoverTimer) {
                clearTimeout(hoverTimer);
                hoverTimer = null;
            }
            hoverTimer = setTimeout(() => {
                modeBtnContainer.style.display = "inline-flex";
                hoverTimer = null;
            }, 200); // 200ms 延遲，避免誤觸發
        };
        
        // 折疊功能
        const hideButtons = () => {
            if (hoverTimer) {
                clearTimeout(hoverTimer);
                hoverTimer = null;
            }
            if (hideTimer) {
                clearTimeout(hideTimer);
                hideTimer = null;
            }
            hideTimer = setTimeout(() => {
                modeBtnContainer.style.display = "none";
                hideTimer = null;
            }, 250); // 稍微延長到 250ms，給鼠標足夠時間移動到向左展開的按鈕上
        };
        
        // 監聽 hoverZone 區域的鼠標進入
        hoverZone.addEventListener("mouseenter", showButtons);
        
        // 監聽 hoverZone 區域的鼠標離開（包括 « 按鈕和 ABC 按鈕）
        hoverZone.addEventListener("mouseleave", hideButtons);
        
        // 儲存清理函數的引用，以便在刷新時清理（可選）
        this._cleanupFns = this._cleanupFns || [];
        this._cleanupFns.push(() => {
            hoverZone.removeEventListener("mouseenter", showButtons);
            hoverZone.removeEventListener("mouseleave", hideButtons);
            if (hoverTimer) clearTimeout(hoverTimer);
            if (hideTimer) clearTimeout(hideTimer);
        });
    }

    // 批量設置文件下所有條目的顯示模式
    async setAllItemsModeForFile(file, items, fileContent, fileSection, fileHeader, mode) {
        // 為該文件下的每個條目設置模式
        for (let idx = 0; idx < items.length; idx++) {
            const itemKey = `${file}|${idx}`;
            this.itemModes.set(itemKey, mode);
        }
        // 刷新該文件區域的顯示
        await this.refreshFileSection(file, items, fileContent, fileSection, fileHeader);
        
        // 顯示提示反饋
        const modeName = mode === 'A' ? '單行模式' : (mode === 'B' ? '3行+滾動模式' : '完全展開模式');
        new Notice(`已將「${file.split('/').pop()}」下所有結果切換為 ${modeName}`);
    }

    // 渲染每個條目的內容
    async renderFileItems(fileSection, fileHeader, fileContent, items, file, startIndex = 0) {
        for (let idx = 0; idx < items.length; idx++) {
            const globalIndex = startIndex + idx;
            const item = items[idx];
            const itemKey = `${file}|${idx}`;
            const currentMode = this.itemModes.get(itemKey) || this.globalMode;
            const contextData = this.getContextLines(fileContent, item.lineNumber, this.currentSearchText, this.isRegexContent, currentMode, this.highlightRegex);
            
            const styles = this.getLineDisplayStyle(currentMode);
            
            // 外層包裝容器 - 不設置焦點屬性
            const itemWrapper = document.createElement("div");
            itemWrapper.style.cssText = "display: flex; align-items: flex-start; gap: 0px; margin-bottom: 2px;";
            
            // 序號容器
            const numberDiv = document.createElement("div");
            numberDiv.textContent = `${idx + 1}`;
            numberDiv.style.cssText = `
                flex-shrink: 0;
                min-width: 12px;
                text-align: center;
                font-size: 10px; 
                cursor: pointer;
                user-select: none;
                background: var(--background-secondary);
                padding: 2px 4px;
                border-radius: 4px;
                margin: 0px 3px 0px -7px;
            `;

            // 獲取當前模式顏色
            const currentModeForColor = this.itemModes.get(itemKey) || this.globalMode;
            const colors = this.plugin.settings.colors || DEFAULT_SETTINGS.colors;
            const modeColors = { A: colors.modeA, B: colors.modeB, C: colors.modeC };
            numberDiv.style.backgroundColor = modeColors[currentModeForColor];
            numberDiv.style.opacity = "0.7";
            
            // 根據模式設置序號文字顏色
            const modeNumberColors = { 
                A: colors.modeANumberColor || "rgba(28, 27, 34, 0.85)",
                B: colors.modeBNumberColor || "rgba(28, 27, 34, 0.85)",
                C: colors.modeCNumberColor || "rgba(255, 255, 255, 0.9)"
            };
            numberDiv.style.color = modeNumberColors[currentModeForColor];

            // 計算下一個模式的函數
            const getNextMode = (current, defaultMode) => {
                const orderFromB = { B: 'C', C: 'A', A: 'B' };
                const orderFromA = { A: 'B', B: 'C', C: 'A' };
                if (defaultMode === 'B') {
                    return orderFromB[current];
                } else {
                    return orderFromA[current];
                }
            };

            numberDiv.onclick = (e) => {
                e.stopPropagation();
                const currentMode = this.itemModes.get(itemKey) || this.globalMode;
                const newMode = getNextMode(currentMode, this.plugin.settings.defaultDisplayMode);
                this.itemModes.set(itemKey, newMode);
                const newColors = this.plugin.settings.colors || DEFAULT_SETTINGS.colors;
                const newModeColors = { A: newColors.modeA, B: newColors.modeB, C: newColors.modeC };
                numberDiv.style.backgroundColor = newModeColors[newMode];
                this.refreshFileSection(file, items, fileContent, fileSection, fileHeader);
            };
            
            itemWrapper.appendChild(numberDiv);
            
            // 內容容器 - 焦點設置在這裡
            const lineContainer = fileSection.createEl("div");
            lineContainer.setAttribute("style", styles.containerStyle);
            lineContainer.onclick = () => this.jumpToLine(item.file, item.lineNumber, this.currentSearchText, this.isRegexContent);
            lineContainer.onmouseenter = () => {
                const hoverColor = this.plugin.settings.colors?.hoverBg || "var(--background-modifier-hover)";
                lineContainer.style.backgroundColor = hoverColor;
                lineContainer.style.borderLeftColor = "var(--interactive-accent)";
            };
            lineContainer.onmouseleave = () => {
                lineContainer.style.backgroundColor = "transparent";
                lineContainer.style.borderLeftColor = "transparent";
            };
            
            // 設置焦點屬性在 lineContainer 上
            lineContainer.setAttribute('tabindex', '-1');
            lineContainer.classList.add('search-result-item-focusable');
            lineContainer.setAttribute('data-item-index', globalIndex);
            
            const contentWrapper = document.createElement("div");
            contentWrapper.style.cssText = "flex: 1; min-width: 0;";
            
            if (currentMode === 'A') {
                const contentSpan = document.createElement("span");
                contentSpan.style.cssText = styles.contentStyle;
                await MarkdownRenderer.renderMarkdown(
                    contextData.content,
                    contentSpan,
                    "",
                    this
                );
                contentSpan.classList.add('vibhasa5');
                contentWrapper.appendChild(contentSpan);
            } else {
                for (const ctxLine of contextData.lines) {
                    const ctxRow = contentWrapper.createEl("div", {
                        attr: { style: "margin-bottom: 2px; white-space: pre-wrap; word-break: break-all;" }
                    });
                    if (ctxLine.isMatchLine) {
                        const matchBgColor = this.plugin.settings.colors?.matchLineBg || "rgba(19, 198, 255, 0.1)";
                        ctxRow.style.backgroundColor = matchBgColor;
                        ctxRow.style.borderRadius = "3px";
                        ctxRow.style.padding = "0 4px";
                    }
                    await MarkdownRenderer.renderMarkdown(
                        ctxLine.content,
                        ctxRow,
                        "",
                        this
                    );
                    ctxRow.classList.add('vibhasa5');
                }
            }
            
            lineContainer.appendChild(contentWrapper);
            itemWrapper.appendChild(lineContainer);
            fileSection.appendChild(itemWrapper);
        }
    }

    async jumpToFile(filePath) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice(`無法找到文件：${filePath}`);
            return;
        }
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
    }

    async jumpToLine(filePath, lineNumber, searchText, isRegex) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice(`無法找到文件：${filePath}`);
            return;
        }
        
        // 檢測是否按住 Ctrl 鍵
        let isCtrlPressed = false;
        const lastEvent = window.event;
        if (lastEvent && lastEvent.ctrlKey) {
            isCtrlPressed = true;
        }
        
        let leaf;
        if (isCtrlPressed) {
            leaf = this.app.workspace.getLeaf('tab');
        } else {
            leaf = this.app.workspace.getLeaf(false);
        }
        
        await leaf.openFile(file);
        const editor = leaf.view.editor;
        if (editor) {
            // 獲取目標行的內容
            const lineContent = editor.getLine(lineNumber - 1);
            
            if (searchText && lineContent) {
                // 在當前行中查找搜索文本的位置
                let searchPos = -1;
                let searchLength = searchText.length;
                
                // 優先使用 highlightRegex
                const highlightRegex = this.highlightRegex;
                if (highlightRegex) {
                    try {
                        const match = highlightRegex.exec(lineContent);
                        if (match) {
                            searchPos = match.index;
                            searchLength = match[0].length;
                        }
                        // 重置正則的 lastIndex
                        highlightRegex.lastIndex = 0;
                    } catch (e) {
                        // 降級到普通搜索
                        if (isRegex) {
                            try {
                                const regex = new RegExp(searchText);
                                const match = regex.exec(lineContent);
                                if (match) {
                                    searchPos = match.index;
                                    searchLength = match[0].length;
                                }
                            } catch (e2) {
                                searchPos = lineContent.indexOf(searchText);
                                searchLength = searchText.length;
                            }
                        } else {
                            searchPos = lineContent.indexOf(searchText);
                            searchLength = searchText.length;
                        }
                    }
                } else if (isRegex) {
                    try {
                        const regex = new RegExp(searchText);
                        const match = regex.exec(lineContent);
                        if (match) {
                            searchPos = match.index;
                            searchLength = match[0].length;
                        }
                    } catch (e) {
                        // 正則無效，改用普通搜索
                        searchPos = lineContent.indexOf(searchText);
                        searchLength = searchText.length;
                    }
                } else {
                    searchPos = lineContent.indexOf(searchText);
                    searchLength = searchText.length;
                }
                
                if (searchPos !== -1) {
                    // 選中搜索文本（這就是高亮！）
                    editor.setSelection(
                        { line: lineNumber - 1, ch: searchPos },
                        { line: lineNumber - 1, ch: searchPos + searchLength }
                    );
                    // 滾動到選中位置並居中
                    editor.scrollIntoView({
                        from: { line: lineNumber - 1, ch: searchPos },
                        to: { line: lineNumber - 1, ch: searchPos + searchLength }
                    }, true);
                } else {
                    // 沒找到搜索文本，只設置光標到行首
                    editor.setCursor({ line: lineNumber - 1, ch: 0 });
                    editor.scrollIntoView({ from: { line: lineNumber - 1, ch: 0 }, to: { line: lineNumber - 1, ch: 0 } }, true);
                }
            } else {
                // 沒有搜索文本，只設置光標
                editor.setCursor({ line: lineNumber - 1, ch: 0 });
                editor.scrollIntoView({ from: { line: lineNumber - 1, ch: 0 }, to: { line: lineNumber - 1, ch: 0 } }, true);
            }
        }
    }

// ==================== 鍵盤導航輔助方法 ====================

    // 更新所有可聚焦的結果條目
    updateFocusableItems() {
        const container = this.containerEl.children[1];
        if (!container) return;
        
        // 收集帶有 search-result-item-focusable 類的元素（可點擊的內容區域）
        this.focusableItems = Array.from(container.querySelectorAll('.search-result-item-focusable'));
        
        // 如果當前聚焦索引有效，嘗試恢復焦點
        if (this.focusedItemIndex >= 0 && this.focusedItemIndex < this.focusableItems.length) {
            this.focusItem(this.focusedItemIndex);
        } else {
            this.focusedItemIndex = -1;
        }
    }

    // 聚焦指定的結果條目
    focusItem(index) {
        if (index < 0 || index >= this.focusableItems.length) return;
        
        // 移除所有條目的聚焦樣式
        this.focusableItems.forEach(item => {
            item.style.outline = 'none';
            item.style.boxShadow = 'none';
            item.style.backgroundColor = 'transparent';
        });
        
        const targetItem = this.focusableItems[index];
        if (targetItem) {
            targetItem.focus();
            // 添加聚焦視覺反饋
            targetItem.style.outline = 'none';
            targetItem.style.boxShadow = '0 0 0 2px var(--interactive-accent)';
            targetItem.style.borderRadius = '4px';
            
            // 滾動到可見區域
            targetItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            
            this.focusedItemIndex = index;
        }
    }

    // 導航到下一個或上一個條目
    navigateItems(direction) {
        if (this.focusableItems.length === 0) return;
        
        let newIndex = this.focusedItemIndex;
        if (direction === 'down') {
            newIndex = this.focusedItemIndex + 1;
            if (newIndex >= this.focusableItems.length) {
                newIndex = 0; // 循環到第一個
            }
        } else if (direction === 'up') {
            newIndex = this.focusedItemIndex - 1;
            if (newIndex < 0) {
                newIndex = this.focusableItems.length - 1; // 循環到最後一個
            }
        }
        
        this.focusItem(newIndex);
    }

    // 跳轉到當前聚焦的條目
    jumpToFocusedItem() {
        if (this.focusedItemIndex < 0 || this.focusedItemIndex >= this.focusableItems.length) return;
        
        const focusedItem = this.focusableItems[this.focusedItemIndex];
        if (!focusedItem) return;
        
        // 觸發點擊事件來跳轉
        const clickEvent = new MouseEvent('click', {
            view: window,
            bubbles: true,
            cancelable: true
        });
        focusedItem.dispatchEvent(clickEvent);
    }

    // 設置鍵盤導航監聽
    setupKeyboardNavigation() {
        const container = this.containerEl.children[1];
        if (!container) return;

        // 移除舊的事件監聽器
        if (this.keyboardHandler) {
            container.removeEventListener('keydown', this.keyboardHandler);
        }
        
        // 創建新的事件處理器
        this.keyboardHandler = (e) => {
            // 檢查當前焦點是否在可聚焦條目上，或者容器獲得焦點
            const activeElement = document.activeElement;
            const isOnFocusableItem = activeElement && activeElement.classList && 
                activeElement.classList.contains('search-result-item-focusable');
            const isContainerFocused = container === activeElement;
            
            // 如果焦點既不在可聚焦條目上，也不在容器上，則不處理
            if (!isOnFocusableItem && !isContainerFocused) {
                return;
            }
            
            // 處理 Ctrl 組合鍵（歷史導航），排除單獨的 Control 鍵
            if (e.ctrlKey && e.key !== 'Control') {
                // 使用 code 檢測方向鍵 // Ctrl+←：上一條搜索歷史  Ctrl+→：下一條搜索歷史   Ctrl+↓：顯示歷史列表
                if (e.code === 'ArrowLeft') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.navigateHistoryPrev();
                    return;
                }
                if (e.code === 'ArrowRight') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.navigateHistoryNext();
                    return;
                }
                if (e.code === 'Backslash') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.showHistoryMenuByKeyboard();
                    return;
                }
            }

            // 處理普通方向鍵和功能鍵（條目導航）
            switch(e.key) {
                case 'ArrowDown':       // ↓：下一個結果條目
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.focusedItemIndex === -1 && this.focusableItems.length > 0) {
                        this.focusItem(0);
                    } else {
                        this.navigateItems('down');
                    }
                    break;
                    
                case 'ArrowUp':         // ↑：上一個結果條目
                    e.preventDefault();
                    e.stopPropagation();
                    if (this.focusedItemIndex === -1 && this.focusableItems.length > 0) {
                        this.focusItem(this.focusableItems.length - 1);
                    } else {
                        this.navigateItems('up');
                    }
                    break;
                    
                case 'Enter':           // Enter：跳轉到當前聚焦的條目
                    if (this.focusedItemIndex !== -1) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.jumpToFocusedItem();
                    }
                    break;
                    
                case 'Home':            // Home：跳轉到第一個結果條目
                    if (this.focusableItems.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.focusItem(0);
                    }
                    break;
                    
                case 'End':             // End：跳轉到最後一個結果條目
                    if (this.focusableItems.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.focusItem(this.focusableItems.length - 1);
                    }
                    break;
                    
                case 'Escape':          // Escape：移除焦點，將焦點轉移到容器
                    if (this.focusedItemIndex !== -1) {
                        e.preventDefault();
                        e.stopPropagation();
                        // 清除所有條目的聚焦樣式
                        this.focusableItems.forEach(item => {
                            item.style.outline = 'none';
                            item.style.boxShadow = 'none';
                            item.style.backgroundColor = 'transparent';
                        });
                        this.focusedItemIndex = -1;
                        container.focus();
                    }
                    break;
            }
        };
        
        // 註冊鍵盤事件監聽器
        container.addEventListener('keydown', this.keyboardHandler);
        // 讓容器可聚焦，以便捕獲鍵盤事件
        container.setAttribute('tabindex', '0');
    }

    // ==================== 歷史導航方法 ====================
    
    // 保存當前搜索到歷史（僅主動搜索時調用）
    // rangeRef: { type, name, patternsText } 其中 type 為 "default"|"group"|"combination"|"custom"
    saveToHistory(searchText, isRegex, rangeRef, isBooleanQuery = false, enableDiacriticIgnore = false, enableHtmlTagIgnore = false) {
        if (!searchText) return;
        
        const history = this.plugin.settings.searchHistory;
        if (!history) return;
        
        // 完全去重：檢查整個歷史，如果存在完全相同條目，則刪除舊的
        let existingIndex = -1;
        for (let i = 0; i < history.items.length; i++) {
            const item = history.items[i];
            if (item.searchText === searchText && 
                item.isRegex === isRegex &&
                JSON.stringify(item.rangeRef) === JSON.stringify(rangeRef)) {
                existingIndex = i;
                break;
            }
        }
        
        // 如果找到重複條目，刪除它
        if (existingIndex !== -1) {
            history.items.splice(existingIndex, 1);
        }
        
        // 創建新歷史條目
        const newItem = {
            searchText: searchText,
            isRegex: isRegex,
            isBooleanQuery: isBooleanQuery,
            enableDiacriticIgnore: enableDiacriticIgnore,
            enableHtmlTagIgnore: enableHtmlTagIgnore || false,
            rangeRef: rangeRef,
            timestamp: Date.now()
        };
        
        // 插入到開頭
        history.items.unshift(newItem);
        
        // 保持最大數量
        const maxSize = this.plugin.settings.maxHistorySize || 10;
        if (history.items.length > maxSize) {
            history.items.pop();
        }
        
        // 重置當前索引為0（最新）
        history.currentIndex = 0;
        
        this.plugin.saveSettings();
    }
    
    // 更新當前歷史索引（基於當前搜索內容和範圍來源）
    updateCurrentHistoryIndex(rangeRef) {
        const history = this.plugin.settings.searchHistory;
        if (!history || history.items.length === 0) {
            history.currentIndex = -1;
            this.plugin.saveSettings();
            return;
        }
        
        // 查找匹配的歷史條目（基於 searchText、isRegex 和 rangeRef）
        const index = history.items.findIndex(item => 
            item.searchText === this.currentSearchText && 
            item.isRegex === this.isRegexContent &&
            JSON.stringify(item.rangeRef) === JSON.stringify(rangeRef)
        );
        
        history.currentIndex = index;
        this.plugin.saveSettings();
    }

    // 加載歷史條目（按索引）
    async loadHistoryItem(index) {
        const history = this.plugin.settings.searchHistory;
        if (!history || index < 0 || index >= history.items.length) return false;

        const item = history.items[index];
        if (!item) return false;

        // 數據修正：確保歷史條目字段完整正確
        let needsSave = false;
        
        // 1. 修正缺失的 isBooleanQuery 字段
        if (item.isBooleanQuery === undefined) {
            item.isBooleanQuery = false;
            needsSave = true;
        }

        // 2. 修正布爾模式下的 isRegex 衝突
        if (item.isBooleanQuery === true && item.isRegex === true) {
            item.isRegex = false;
            needsSave = true;
        }

        // 3. 修正缺失的 rangeRef
        if (!item.rangeRef) {
            item.rangeRef = { type: "default", name: null, patternsText: null };
            needsSave = true;
        }

        // 👉 4. 修正缺失的 enableDiacriticIgnore 字段
        if (item.enableDiacriticIgnore === undefined) {
            item.enableDiacriticIgnore = false;
            needsSave = true;
        }

        // 👉 5. 修正缺失的 enableHtmlTagIgnore 字段
        if (item.enableHtmlTagIgnore === undefined) {
            item.enableHtmlTagIgnore = false;
            needsSave = true;
        }

        // 如果有修正，立即保存到文件
        if (needsSave) {
            await this.plugin.saveSettings();
        }

        // 更新當前索引
        history.currentIndex = index;
        await this.plugin.saveSettings();
        
        const rangeRef = item.rangeRef;
        const searchText = item.searchText;
        const isRegex = item.isRegex;
        
        // 根據 rangeRef 類型決定如何獲取 patterns
        let patternsToUse = null;
        let isPreset = false;
        let rangeDisplay = null;
        
        if (rangeRef.type === "default") {
            // 使用插件默認預設範圍
            patternsToUse = [];
            isPreset = true;
            rangeDisplay = "預設";
        }
        else if (rangeRef.type === "group" && !rangeRef.patternsText) {
            // 直接使用文件組（動態加載）
            const groups = this.plugin.settings.fileGroups?.groups || {};
            const group = groups[rangeRef.name];
            if (group && group.patterns && group.patterns.length > 0) {
                patternsToUse = group.patterns.join('\n');
                rangeDisplay = `組：${rangeRef.name}`;
            } else {
                new Notice(`文件組「${rangeRef.name}」不存在或為空`);
                return false;
            }
        }
        else if (rangeRef.type === "combination" && !rangeRef.patternsText) {
            // 直接使用組合（動態加載）
            const groups = this.plugin.settings.fileGroups?.groups || {};
            const combinations = this.plugin.settings.fileGroups?.combinations || {};
            const combo = combinations[rangeRef.name];
            if (combo && combo.groups && combo.groups.length > 0) {
                const allPatterns = [];
                for (const groupName of combo.groups) {
                    const group = groups[groupName];
                    if (group && group.patterns) {
                        allPatterns.push(...group.patterns);
                    }
                }
                if (allPatterns.length > 0) {
                    patternsToUse = allPatterns.join('\n');
                    rangeDisplay = `組合：${rangeRef.name}`;
                } else {
                    new Notice(`組合「${rangeRef.name}」無效`);
                    return false;
                }
            } else {
                new Notice(`組合「${rangeRef.name}」不存在或為空`);
                return false;
            }
        }
        else if (rangeRef.patternsText) {
            // 有 patternsText 的情況：修改版或自定義
            const lines = rangeRef.patternsText.split(/\r?\n/);
            const validPatterns = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    try {
                        new RegExp(trimmed);
                        validPatterns.push(trimmed);
                    } catch(e) {}
                }
            }
            if (validPatterns.length > 0) {
                patternsToUse = validPatterns.join('\n');
                // 生成顯示文字
                if (rangeRef.type === "group") {
                    rangeDisplay = `組：${rangeRef.name}（改）`;
                } else if (rangeRef.type === "combination") {
                    rangeDisplay = `組合：${rangeRef.name}（改）`;
                } else {
                    rangeDisplay = "自訂";
                }
            } else {
                new Notice("歷史記錄中的文件範圍無效");
                return false;
            }
        }

        if (patternsToUse) {
            await this.plugin.searchAndShowInSidebar(searchText, patternsToUse, isPreset, rangeDisplay, true, rangeRef, item.isBooleanQuery || false, item.enableDiacriticIgnore || false, item.enableHtmlTagIgnore || false);
            return true;
        }
        
        return false;
    }

    // 導航到上一個歷史（不循環）—— 往更舊的方向
    async navigateHistoryPrev() {
        const history = this.plugin.settings.searchHistory;
        if (!history || history.items.length === 0) {
            new Notice("暫無搜索歷史");
            return;
        }
        
        let newIndex = history.currentIndex + 1;   // 往更舊
        if (newIndex >= history.items.length) {
            new Notice("已是最舊搜索");
            return;
        }
        
        // 關閉歷史面板（如果存在的話）
        this.closeHistoryPanel();
        
        await this.loadHistoryItem(newIndex);
    }

    // 導航到下一個歷史（不循環）—— 往更新的方向
    async navigateHistoryNext() {
        const history = this.plugin.settings.searchHistory;
        if (!history || history.items.length === 0) {
            new Notice("暫無搜索歷史");
            return;
        }
        
        let newIndex = history.currentIndex - 1;   // 往更新
        if (newIndex < 0) {
            new Notice("已是最新搜索");
            return;
        }
        
        // 關閉歷史面板（如果存在的話）
        this.closeHistoryPanel();
        
        await this.loadHistoryItem(newIndex);
    }

    // 顯示歷史列表菜單（長按時調用。自定義懸浮 div，固定在左箭頭正下方）
    showHistoryMenu(arrowDirection, triggerBtn = null) {
        const history = this.plugin.settings.searchHistory;
        if (!history || history.items.length === 0) {
            new Notice("暫無搜索歷史");
            return;
        }
        
        // 獲取左箭頭按鈕的位置
        if (!this.prevBtnRef) {
            new Notice("請先執行一次搜索");
            return;
        }

        const btnRect = this.prevBtnRef.getBoundingClientRect();

        // 從設置中獲取面板寬度
        const PANEL_WIDTH = this.plugin.settings.historyPanelWidth || 256;
        
        // 創建懸浮面板
        const panel = document.createElement('div');
        panel.className = 'custom-search-history-panel';
        panel.style.cssText = `
            position: fixed;
            z-index: 10000;
            background: rgba(var(--background-primary-rgb), 0.9);
            backdrop-filter: blur(6px);
            border: 1px solid var(--background-modifier-border);
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            width: ${PANEL_WIDTH}px;
            max-width: 90vw;
            max-height: 400px;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        `;

        // 計算位置（左箭頭正下方）
        let top = btnRect.bottom + 4;
        let left = btnRect.left - 165;

        // 邊界檢測：避免超出右邊界
        if (left + PANEL_WIDTH > window.innerWidth) {
            left = window.innerWidth - PANEL_WIDTH - 10;
        }
        // 邊界檢測：避免超出左邊界
        if (left < 10) {
            left = 10;
        }
        // 邊界檢測：避免超出底部邊界
        if (top + 400 > window.innerHeight) {
            top = btnRect.top - 400 - 4;
        }
        
        panel.style.top = `${top}px`;
        panel.style.left = `${left}px`;

        // 標題欄
        const header = panel.createEl("div", {
            attr: { style: "padding: 8px 12px; border-bottom: 1px solid var(--background-modifier-border); font-weight: 600; background: var(--background-secondary); display: flex; justify-content: space-between; align-items: center;" }
        });
        const headerTitle = header.createEl("span", { text: "📜 搜索歷史", attr: { style: "font-size: 13px;" } });
        const headerCount = header.createEl("span", { text: "", attr: { style: "font-size: 11px; color: var(--text-muted);" } });
        
        // 更新計數顯示的函數
        const updateHeaderCount = () => {
            if (history.items.length === 0) {
                headerCount.textContent = `(0/0)`;
            } else {
                const position = history.currentIndex + 1;  // 索引轉位置（1-based）
                headerCount.textContent = `(${position}/${history.items.length})`;
            }
        };
        
        // 關閉按鈕
        const closeBtn = header.createEl("button", {
            text: "✕",
            attr: { style: "background: transparent; border: none; cursor: pointer; font-size: 14px; color: var(--text-muted); padding: 0 4px;" }
        });
        closeBtn.onclick = () => panel.remove();
        
        // 初始調用更新計數
        updateHeaderCount();

        // 列表容器（可滾動）
        const listContainer = panel.createEl("div", {
            attr: { style: "flex: 1; overflow-y: auto; max-height: 350px; padding: 4px 0;" }
        });
        
        // 鍵盤聚焦的歷史條目索引（-1 表示無鍵盤聚焦）
        let keyboardFocusIndex = -1;
        
        // 存儲所有行元素的數組
        let rowElements = [];
        
        // 標記是否處於鍵盤導航模式
        let isKeyboardMode = false;

        // 更新所有行的樣式（根據 isCurrent 和 keyboardFocusIndex）
        const updateAllRowStyles = () => {
            rowElements.forEach((row, idx) => {
                const isCurrent = (idx === history.currentIndex);
                const isKeyboardFocused = (idx === keyboardFocusIndex);
                
                if (isCurrent) {
                    // 當前激活條目：始終保持強調色，不受鼠標或鍵盤影響
                    row.style.backgroundColor = "var(--interactive-accent)";
                    row.style.opacity = "0.85";
                } else if (isKeyboardFocused && isKeyboardMode) {
                    // 非激活條目 + 鍵盤聚焦：使用懸停背景色
                    row.style.backgroundColor = "var(--background-modifier-hover)";
                    row.style.opacity = "1";
                } else {
                    // 普通條目：透明
                    row.style.backgroundColor = "transparent";
                    row.style.opacity = "1";
                }
            });
        };

        // 清除鍵盤聚焦狀態，切換到鼠標模式
        const exitKeyboardMode = () => {
            isKeyboardMode = false;
            keyboardFocusIndex = -1;
            updateAllRowStyles();
        };

        // 加載指定索引的歷史並直接執行搜索
        const loadAndClose = async (index) => {
            if (index >= 0 && index < history.items.length) {
                await this.loadHistoryItem(index);
                panel.remove();
            }
        };

        // 鍵盤事件處理函數
        const onPanelKeyDown = (e) => {
            // 阻止事件冒泡，避免影響背景
            e.stopPropagation();
            
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    // 進入鍵盤模式
                    if (!isKeyboardMode) {
                        isKeyboardMode = true;
                        // 第一次按 ↓：直接移動到當前激活條目的下一條
                        if (history.currentIndex !== -1 && history.currentIndex < history.items.length) {
                            // 從當前激活條目往下移動一格
                            keyboardFocusIndex = history.currentIndex + 1;
                            if (keyboardFocusIndex >= history.items.length) {
                                keyboardFocusIndex = history.items.length - 1; // 如果已經是最後一條，則停在最後一條
                            }
                        } else {
                            keyboardFocusIndex = 0;
                        }
                    } else {
                        // 向下移動聚焦
                        if (keyboardFocusIndex < history.items.length - 1) {
                            keyboardFocusIndex++;
                        } else {
                            keyboardFocusIndex = 0; // 循環到第一個
                        }
                    }
                    // 滾動到可視區域
                    if (rowElements[keyboardFocusIndex]) {
                        rowElements[keyboardFocusIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                    updateAllRowStyles();
                    break;
                    
                case 'ArrowUp':
                    e.preventDefault();
                    // 進入鍵盤模式
                    if (!isKeyboardMode) {
                        isKeyboardMode = true;
                        // 第一次按 ↑：直接移動到當前激活條目的上一條
                        if (history.currentIndex !== -1 && history.currentIndex < history.items.length) {
                            // 從當前激活條目往上移動一格
                            keyboardFocusIndex = history.currentIndex - 1;
                            if (keyboardFocusIndex < 0) {
                                keyboardFocusIndex = 0; // 如果已經是第一個，則停在第一個
                            }
                        } else {
                            keyboardFocusIndex = history.items.length - 1;
                        }
                    } else {
                        // 向上移動聚焦
                        if (keyboardFocusIndex > 0) {
                            keyboardFocusIndex--;
                        } else {
                            keyboardFocusIndex = history.items.length - 1; // 循環到最後一個
                        }
                    }
                    // 滾動到可視區域
                    if (rowElements[keyboardFocusIndex]) {
                        rowElements[keyboardFocusIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                    updateAllRowStyles();
                    break;
                    
                case 'Enter':
                    e.preventDefault();
                    if (isKeyboardMode && keyboardFocusIndex !== -1) {
                        loadAndClose(keyboardFocusIndex);
                    } else if (history.currentIndex !== -1) {
                        // 沒有鍵盤聚焦時，加載當前激活的歷史
                        loadAndClose(history.currentIndex);
                    }
                    break;
                    
                case 'Escape':
                    e.preventDefault();
                    panel.remove();
    // 關閉後聚焦到結果面板容器
    const container = this.containerEl.children[1];
    if (container) {
        container.focus();
    }
                    break;
                    
                default:
                    break;
            }
        };

        // 鼠標進入列表容器時，退出鍵盤模式
        const onMouseEnterContainer = () => {
            exitKeyboardMode();
        };

        // 渲染歷史列表
        const renderList = () => {
            listContainer.empty();
            rowElements = [];
            
            // 重置鍵盤狀態
            keyboardFocusIndex = -1;
            isKeyboardMode = false;
            
            if (history.items.length === 0) {
                listContainer.createEl("div", {
                    text: "暫無搜索歷史",
                    attr: { style: "padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px;" }
                });
                return;
            }
            
            history.items.forEach((item, idx) => {
                const isCurrent = (idx === history.currentIndex);
                
                // 每一行容器
                const row = listContainer.createEl("div", {
                    attr: {
                        style: `
                            display: flex;
                            align-items: center;
                            justify-content: space-between;
                            padding: 6px 12px;
                            margin: 2px 8px;
                            border-radius: 6px;
                            cursor: pointer;
                            transition: all 0.15s;
                            background: ${isCurrent ? "var(--interactive-accent)" : "transparent"};
                            opacity: ${isCurrent ? "0.85" : "1"};
                        `
                    }
                });

                // 鼠標懸停效果（只在非鍵盤模式下生效，且當前激活條目不響應懸停）
                row.onmouseenter = () => {
                    if (!isKeyboardMode && !isCurrent) {
                        row.style.backgroundColor = "var(--background-modifier-hover)";
                    }
                };
                row.onmouseleave = () => {
                    if (!isKeyboardMode && !isCurrent) {
                        row.style.backgroundColor = "transparent";
                    }
                    // 如果是當前激活條目，確保恢復強調色
                    if (isCurrent) {
                        row.style.backgroundColor = "var(--interactive-accent)";
                        row.style.opacity = "0.85";
                    }
                };

                // 左側：歷史內容（點擊加載）
                const displayText = this.getHistoryDisplayText(item);
                const textSpan = row.createEl("span", {
                    text: displayText,
                    attr: {
                        style: `
                            flex: 1;
                            font-size: 12px;
                            font-family: monospace;
                            overflow: hidden;
                            text-overflow: ellipsis;
                            white-space: nowrap;
                            color: ${isCurrent ? "var(--text-on-accent)" : "var(--text-normal)"};
                        `,
                        title: displayText
                    }
                });

                // 右側：刪除按鈕 ✕
                const deleteBtn = row.createEl("button", {
                    text: "✕",
                    attr: {
                        style: `
                            width: 22px;
                            height: 22px;
                            border-radius: 4px;
                            background: transparent;
                            border: none;
                            cursor: pointer;
                            font-size: 12px;
                            color: ${isCurrent ? "var(--text-on-accent)" : "var(--text-muted)"};
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            margin-left: 8px;
                            transition: all 0.15s;
                        `
                    }
                });
                
                // 刪除按鈕懸停效果
                deleteBtn.onmouseenter = () => {
                    deleteBtn.style.backgroundColor = "var(--background-modifier-error)";
                    deleteBtn.style.color = "white";
                };
                deleteBtn.onmouseleave = () => {
                    deleteBtn.style.backgroundColor = "transparent";
                    deleteBtn.style.color = isCurrent ? "var(--text-on-accent)" : "var(--text-muted)";
                };

                // 刪除按鈕點擊事件
                deleteBtn.onclick = async (e) => {
                    e.stopPropagation();
                    await this.deleteHistoryItem(idx, history);
                    
                    // 調整歷史數據後重新渲染
                    if (history.items.length === 0) {
                        panel.remove();
                        new Notice("歷史記錄已清空");
                        return;
                    }
                    renderList();
                    updateHeaderCount();
                };

                // 行點擊事件（加載歷史）
                row.onclick = async () => {
                    await loadAndClose(idx);
                };

                row.appendChild(textSpan);
                row.appendChild(deleteBtn);
                rowElements.push(row);
            });

            // 底部清除所有按鈕
            const footer = listContainer.createEl("div", {
                attr: {
                    style: `
                        margin: 8px;
                        padding-top: 8px;
                        border-top: 1px solid var(--background-modifier-border);
                    `
                }
            });
            
            const clearAllBtn = footer.createEl("button", {
                text: "🗑️ 清除所有歷史",
                attr: {
                    style: `
                        width: 100%;
                        padding: 6px 12px;
                        background: var(--background-modifier-error);
                        color: white;
                        border: none;
                        border-radius: 6px;
                        cursor: pointer;
                        font-size: 12px;
                    `
                }
            });
            clearAllBtn.onclick = async () => {
                history.items = [];
                history.currentIndex = -1;
                await this.plugin.saveSettings();
                new Notice("已清除所有搜索歷史");
                panel.remove();
            };
        };
        
        renderList();

        // 添加到頁面
        document.body.appendChild(panel);
        
        // 設置面板可聚焦，並自動聚焦
        panel.setAttribute('tabindex', '0');
        
        // 監聽鼠標進入列表容器（用於退出鍵盤模式）
        listContainer.addEventListener('mouseenter', onMouseEnterContainer);
        
        // 添加鍵盤事件監聽
        panel.addEventListener('keydown', onPanelKeyDown);
        
        // 面板打開後自動聚焦，默認為鼠標模式
        setTimeout(() => {
            panel.focus();
        }, 50);
        
        // 關閉時清理事件監聽
        const cleanup = () => {
            panel.removeEventListener('keydown', onPanelKeyDown);
            listContainer.removeEventListener('mouseenter', onMouseEnterContainer);
            document.removeEventListener('mousedown', closeOnOutsideMouseDown);
            document.removeEventListener('keydown', closeOnEsc);
        };
        
        // 外部點擊關閉面板
        const closeOnOutsideMouseDown = (e) => {
            // 獲取實際點擊的元素
            let target = e.target;
            
            // 檢查是否點擊了觸發按鈕（或其內部子元素）
            if (triggerBtn && (triggerBtn === target || triggerBtn.contains(target))) {
                return;  // 不關閉面板
            }
            // 檢查是否點擊了另一個箭頭按鈕
            if (this.prevBtnRef && (this.prevBtnRef === target || this.prevBtnRef.contains(target))) {
                return;
            }
            if (this.nextBtnRef && (this.nextBtnRef === target || this.nextBtnRef.contains(target))) {
                return;
            }
            // 檢查是否點擊了面板內部
            if (panel.contains(target)) {
                return;
            }
            // 點擊外部，關閉面板
            if (triggerBtn) {
                triggerBtn._mouseUpDisabled = false;
            }
            cleanup();
            panel.remove();
        };
        
        // ESC 鍵關閉面板（備用，因為 panel 已經有 ESC 處理）
        const closeOnEsc = (e) => {
            if (e.key === 'Escape') {
                cleanup();
                if (triggerBtn) {
                    triggerBtn._mouseUpDisabled = false;
                }
                panel.remove();
                document.removeEventListener('mousedown', closeOnOutsideMouseDown);
                document.removeEventListener('keydown', closeOnEsc);
            }
        };
        
        // 立即添加事件
        document.addEventListener('mousedown', closeOnOutsideMouseDown);
        document.addEventListener('keydown', closeOnEsc);
        
        // 保存清理函數引用，以便在面板被其他方式關閉時也能清理
        panel._cleanup = cleanup;
    }

    // 獲取歷史條目的顯示文本
    getHistoryDisplayText(item) {
        return this.plugin.getHistoryDisplayText(item);
    }

    // 刪除指定歷史條目
    async deleteHistoryItem(index, history) {
        if (index < 0 || index >= history.items.length) return;
        
        // 刪除條目
        history.items.splice(index, 1);
        
        // 調整當前索引
        if (history.currentIndex === index) {
            history.currentIndex = -1;
        } else if (history.currentIndex > index) {
            history.currentIndex--;
        }
        
        await this.plugin.saveSettings();
        new Notice("已刪除歷史記錄");
    }

    // 關閉歷史面板（如果存在的話）
    closeHistoryPanel() {
        const panel = document.querySelector('.custom-search-history-panel');
        if (panel) {
            panel.remove();
        }
    }

    /**
     * 从现有对话框提取 DOM 元素引用
     * @param {HTMLElement} modal - 对话框元素
     * @returns {Object|null} dialogRefs 对象
     */
    extractDialogRefs(modal) {
        if (!modal || !modal._dialogRefs) return null;
        return modal._dialogRefs;
    }

    // 通過鍵盤快捷鍵顯示歷史列表（固定在左箭頭下方）
    async showHistoryMenuByKeyboard() {
        const history = this.plugin.settings.searchHistory;
        if (!history || history.items.length === 0) {
            new Notice("暫無搜索歷史");
            return;
        }
        
        // 使用與長按相同的面板
        if (this.prevBtnRef) {
            this.showHistoryMenu('keyboard', this.prevBtnRef);
        } else {
            new Notice("請先執行一次搜索");
        }
    }

    // 設置歷史導航按鈕（帶長按檢測）
    setupHistoryNavButtons(buttonRow) {
        const navContainer = buttonRow.createEl("div", {
            attr: { style: "display: flex; align-items: center; gap: 6px; margin-right: 8px;" }
        });

        // 圓形背景樣式
        const btnStyle = `
            width: 28px;
            height: 28px;
            border-radius: 50%;
            color: rgba(150, 150, 150, 50);
            background: rgba(251, 251, 251, 0);
            border: 1px solid rgba(251, 251, 251, 0);
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        `;

        // 上一條按鈕  ❮ 
        const prevBtn = navContainer.createEl("button", {
            text: "❮",
            attr: { style: btnStyle, title: "上一條搜索 (Ctrl+←) - 長按查看歷史" }
        });
        this.prevBtnRef = prevBtn;  // 保存引用，供快捷鍵使用
        
        // 下一條按鈕 ❯ 
        const nextBtn = navContainer.createEl("button", {
            text: "❯",
            attr: { style: btnStyle, title: "下一條搜索 (Ctrl+→) - 長按查看歷史" }
        });
        this.nextBtnRef = nextBtn;  // 保存引用，供快捷鍵使用
        
        // 添加懸停效果
        const addHoverEffect = (btn) => {
            btn.onmouseenter = () => {
                btn.style.backgroundColor = "var(--background-modifier-hover)";
            };
            btn.onmouseleave = () => {
                btn.style.backgroundColor = "rgba(251, 251, 251, 0)";
            };
        };
        addHoverEffect(prevBtn);
        addHoverEffect(nextBtn);

        // 長按檢測函數
        const setupLongPress = (btn, direction) => {
            let pressTimer = null;
            let isLongPress = false;
            let longPressTriggered = false;  // 標記長按是否已觸發面板
            
            const startPress = () => {
                isLongPress = false;
                longPressTriggered = false;
                pressTimer = setTimeout(() => {
                    isLongPress = true;
                    longPressTriggered = true;
                    // 長按觸發時，禁用按鈕的 mouseup 事件
                    btn._mouseUpDisabled = true;
                    this.showHistoryMenu(direction, btn);
                }, 300);
            };
            
            const cancelPress = () => {
                if (pressTimer) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                }
            };
            
            const onMouseUp = async () => {
                // 如果按鈕的 mouseup 被禁用，直接返回
                if (btn._mouseUpDisabled) {
                    btn._mouseUpDisabled = false;
                    return;
                }
                if (isLongPress) {
                    isLongPress = false;
                    return;
                }
                cancelPress();
                if (direction === 'prev') {
                    await this.navigateHistoryPrev();
                } else {
                    await this.navigateHistoryNext();
                }
            };
            
            btn.addEventListener('mousedown', startPress);
            btn.addEventListener('mouseup', onMouseUp);
            btn.addEventListener('mouseleave', cancelPress);
        };
        
        setupLongPress(prevBtn, 'prev');
        setupLongPress(nextBtn, 'next');
        
        return navContainer;
    }

    updateResults(searchText, results, isRegexContent = false, statsText = "", patternsArray = [], patternsText = "", isPreset = false, rangeDisplay = "", rangeRef = null, isBooleanQuery = false, highlightRegex = null, enableDiacriticIgnore = false, enableHtmlTagIgnore = false) {
        this.currentSearchText = searchText;
        this.currentPatterns = patternsArray; // 保存模式數組
        this.currentPatternsText = patternsText; // 保存原始模式文本
        this.currentIsPreset = isPreset; // 保存是否為預設範圍
        this.currentRangeDisplay = rangeDisplay; // 保存範圍顯示文字
        this.currentRangeRef = rangeRef; // 保存範圍引用
        this.enableDiacriticIgnore = enableDiacriticIgnore;
        this.enableHtmlTagIgnore = enableHtmlTagIgnore;
        this.highlightRegex = highlightRegex; // 保存高亮用的正則

        // 應用排序（如果啟用）
        let sortedResults = results;
        if (this.plugin.settings.enableSorting) {
            const fileGroups = this.plugin.settings.fileGroups;
            
            // 構建搜索上下文
            const searchContext = {
                allGroups: fileGroups.groups || {},
                patternsForB: patternsArray,  // 當前搜索範圍的模式
                needGroupPriority: false,
                groupPriorityList: [],
                groupNamesForC: []
            };
            
            // 根據 rangeRef 判斷搜索類型，決定是否需要 C 規則
            if (rangeRef && rangeRef.type === 'combination') {
                // 組合搜索：需要 C 規則
                searchContext.needGroupPriority = true;
                searchContext.groupPriorityList = this.plugin.settings.groupPriority || [];
                
                // 獲取組合包含的組名列表
                const combinations = fileGroups.combinations || {};
                const combo = combinations[rangeRef.name];
                if (combo && combo.groups) {
                    searchContext.groupNamesForC = combo.groups;
                }
            }
            // 其他搜索類型（預定範圍、文件組、修改版、自定義）不需要 C 規則
            
            this.sorter = new ResultSorter(this.plugin.settings);
            sortedResults = this.sorter.sortResults(results, searchContext);
        }

        this.currentResults = sortedResults;
        this.isRegexContent = isRegexContent;
        this.isBooleanQuery = isBooleanQuery;
        this.statsText = statsText;
        this.fileContents.clear();
        this.itemModes.clear();
        this.globalMode = this.plugin.settings.defaultDisplayMode;
        const container = this.containerEl.children[1];
        if (container) {
            this.renderResults(container);
        }

        // 重置聚焦狀態
        this.focusedItemIndex = -1;
        this.focusableItems = [];
        
        // 保存到歷史（僅當是主動搜索時，通過標誌判斷）
        if (this._shouldSaveToHistory && rangeRef) {
            this.saveToHistory(searchText, isRegexContent, rangeRef, this.isBooleanQuery, enableDiacriticIgnore, enableHtmlTagIgnore);
            this._shouldSaveToHistory = false;
        }
        
        // 更新當前歷史索引（傳入 rangeRef）
        this.updateCurrentHistoryIndex(rangeRef);
    }
    
    // 標記此次更新為主動搜索（需要保存到歷史）
    markAsActiveSearch() {
        this._shouldSaveToHistory = true;
    }
}

// ==================== 插件設置 ====================
const DEFAULT_SETTINGS = {
    version: "2.4.1",  // 主版本.次版本.修訂版本。版本號，用於數據遷移

    enableBooleanQuery: false,  // 布爾查詢默認值
    enableHtmlTagIgnore: false,     // 無視標籤默認值
    enableDiacriticIgnore: false,   // 忽略變音默認值
    defaultDisplayMode: 'B', // 'A' 'B' 或 'C'
    defaultFilePatterns: [  // 用戶自定義的默認文件模式
        "(books|mynotes)[\\d-]+\\.md",
        "note[\\d-]+\\.md",
        "^kosa\\/.+\\.md",
        "T44n1851_.*\\d+\\.md"
    ],
    fileGroups: {
        groups: {
            文件組a1: {
                patterns: [
                    "AKBh\\d+\\.md"
                ]
            },
            文件組a2: {
                patterns: [
                    "^kosa\\/ju\\/.+\\.md",
                    "T22n1428.*\\d+\\.md"
                ]
            }
        },
        combinations: {
            組合1: {
                groups: [
                    "文件組a1",
                    "文件組a2"
                ]
            }
        },
        defaultPreset: null
    },
    // 排序設置
    enableSorting: true,           // 是否啟用排序
    filePriority: [],              // 文件優先級（每行一個正則）
    groupPriority: [
        "文件組a2",
        "文件組a1"
    ],
    groupPatternOrder: {     // 組內正則行順序 { groupName: { patternSource: order } }
        文件組a2: {
            "T22n1428.*\\d+\\.md": 0,
            "^kosa\\/ju\\/.+\\.md": 1
        }
    },
    // 顏色設置
    colors: {
        fileName: "rgba(84, 27, 7, 0.7)",    // 半透明深棕色 文件名顏色 var(--text-accent)
        matchLineBg: "rgba(19, 198, 255, 0.1)",  // 淺藍透明 匹配行背景色
        keywordBg: "rgba(255, 235, 59, 0.85)",   // 黃色 關鍵詞高亮背景 var(--text-highlight-bg)
        hoverBg: "rgba(0, 0, 0, 0.1)",           // 淺黑透明 懸停背景色 var(--background-modifier-hover)
        modeA: "rgba(255, 255, 255, 0.31)",      // 白色半透明 A模式按鈕顏色
        modeB: "rgba(184, 184, 184, 1)",       // 灰色 B模式按鈕顏色
        modeC: "rgba(28, 28, 28, 0.56)",      // 深灰色半透明 C模式按鈕顏色
        activeBorder: "rgba(151, 247, 180, 0.75)", // 激活模式外框顏色
        modeANumberColor: "rgba(28, 27, 34, 0.85)",   // A模式序號文字顏色（深色）
        modeBNumberColor: "rgba(28, 27, 34, 0.85)",   // B模式序號文字顏色（深色）
        modeCNumberColor: "rgba(255, 255, 255, 0.9)"  // C模式序號文字顏色（白色）
    },
    // 搜索歷史（只保存主動搜索）
    maxHistorySize: 10,  // 最大保存歷史數量
    historyPanelWidth: 256,  // 歷史面板寬度（像素）
    searchHistory: {
        items: [
            {
                searchText: "這是一個配置文件格式示例，版本更新時可以參考",
                isRegex: false,
                isBooleanQuery: false,
                enableDiacriticIgnore: false,
                enableHtmlTagIgnore: false,
                rangeRef: {
                    type: "default",  // 可選值: "default", "patterns", "groups", "combinations"
                    name: null,
                    patternsText: null
                },
                timestamp: 1777647764280
            }
        ],
        currentIndex: -1  // 當前激活的歷史索引，-1表示不在歷史中（如新的主動搜索）
    },
    // 字符寬度設置（用於A模式截取）
    charWidth: {
        // 窄字符範圍（每個折算0.2單位）- 支持單個碼位或 "起始-結束"
        compensatedRanges: [
            "0x0F08",                    // ༈ 
            "0x0F0B-0x0F0D",            // ་ ༌ ། 
            "0x0F0F-0x0F11",            // ༏ ༐ ༑ 
            "0x0FD2"                     // ࿒ 
        ],
        // 零寬度字符範圍（完全跳過）- 支持單個碼位或 "起始-結束"
        zeroWidthRanges: [
            "0x0F71-0x0F7E",            //  ཱ ི ཱི ུ ཱུ ྲྀ ཷ ླྀ ཹ ེ ཻ ོ ཽ ཾ藏文
            "0x0F80-0x0F84",            //   ྀ ཱྀ ྂ ྃ ྄  藏文
            "0x0F8D-0x0FBC",            //    ྍ ྎ ྏ  ྐ ྑ ྒ ྒྷ ྔ ྕ ྖ ྗ ྘ ྙ ྚ ྛ ྜ ྜྷ ྞ ྟ  ྠ ྡ ྡྷ ྣ ྤ ྥ ྦ ྦྷ ྨ ྩ ྪ ྫ ྫྷ ྭ ྮ ྯ ྰ ྱ ྲ ླ ྴ ྵ ྶ ྷ ྸ ྐྵ ྺ ྻ ྼ  藏文
            "0x0900-0x0902",
            "0x094D",                    //  ऀ ँ ं ्  
            "0x0941-0x0948",             // ु ू ृ ॄ ॅ ॆ े ै 
            "0x093A",
            "0x093C",                    // ऺ ़  
            "0x0962-0x0963"              // ॢ ॣ 
        ]
    }
};

// ==================== 手寫搜索查詢 Modal ====================
class HandwriteQueryModal extends Modal {
    constructor(app, plugin, previousSearchText, previousFileName, prefillQuery, resolveCallback) {
        super(app);
        this.plugin = plugin;
        this.previousSearchText = previousSearchText;
        this.previousFileName = previousFileName;
        this.prefillQuery = prefillQuery;
        this.resolveCallback = resolveCallback;
        this.activeTab = 'manual';
    }

    onOpen() {
        const { modalEl, contentEl } = this;

        // 設置外層彈窗容器的寬度
        modalEl.style.minWidth = "700px";
        modalEl.style.maxWidth = "95vw";
        modalEl.style.width = "auto";

        // 設置內容區域
        contentEl.empty();
        contentEl.style.width = "100%";
        contentEl.style.padding = "20px";
        
        this.buildUI(contentEl);
    }

    buildUI(contentEl) {
        const title = document.createElement('div');
        title.textContent = '手寫搜索查詢';
        title.style.cssText = `font-size: 18px; font-weight: 600; margin-bottom: 20px; text-align: center;`;
        contentEl.appendChild(title);
        
        const tabContainer = document.createElement('div');
        tabContainer.style.cssText = `display: flex; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 16px;`;
        
        const manualTab = document.createElement('button');
        manualTab.textContent = '✍️ 手動編輯';
        manualTab.style.cssText = `padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;`;
        
        const helperTab = document.createElement('button');
        helperTab.textContent = '🔧 輔助編輯';
        helperTab.style.cssText = `padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;`;
        
        tabContainer.appendChild(manualTab);
        tabContainer.appendChild(helperTab);
        contentEl.appendChild(tabContainer);
        
        const manualPanel = document.createElement('div');
        manualPanel.style.cssText = `display: block;`;
        
        const queryLabel = document.createElement('div');
        queryLabel.textContent = '📝 搜索查詢（支持Obsidian搜索語法）：';
        queryLabel.style.cssText = `font-size: 13px; margin-bottom: 6px;`;
        manualPanel.appendChild(queryLabel);
        
        const queryTextarea = document.createElement('textarea');
        queryTextarea.style.cssText = `width: 100%; padding: 10px; margin-bottom: 16px; border: 1px solid var(--background-modifier-border); border-radius: 6px; font-family: monospace; resize: vertical; min-height: 180px;`;
        queryTextarea.placeholder = '例如：line:(佛即知子曹疑) file:/義足經/';
        if (this.prefillQuery) queryTextarea.value = this.prefillQuery;
        else if (this.previousSearchText) queryTextarea.value = this.previousSearchText;
        manualPanel.appendChild(queryTextarea);
        
        const helperPanel = document.createElement('div');
        helperPanel.style.cssText = `display: none;`;
        
        const helperStyle = document.createElement('style');
        helperStyle.textContent = `
            .search-form-container-helper .form-row {
                display: flex;
                gap: 5px;
                align-items: center;
                margin-bottom: 10px;
                flex-wrap: wrap;
            }
            .search-form-container-helper .form-row:first-child .operator,
            .search-form-container-helper .form-row:first-child .remove-row {
                display: none;
            }
            .search-form-container-helper input[type="text"] {
                flex: 1;
                min-width: 150px;
                padding: 6px 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
            }
            .search-form-container-helper select {
                padding: 6px 8px;
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                background: var(--background-primary);
                color: var(--text-normal);
            }
            .search-form-container-helper button {
                padding: 6px 12px;
                background: var(--background-secondary);
                border: 1px solid var(--background-modifier-border);
                border-radius: 4px;
                cursor: pointer;
                color: var(--text-normal);
            }
            .search-form-container-helper .controls {
                display: flex;
                gap: 4px;
            }
            .search-form-container-helper .toggle {
                cursor: pointer;
                display: flex;
            }
            .search-form-container-helper .toggle input {
                display: none;
            }
            .search-form-container-helper .toggle-label {
                display: flex;
                align-items: center;
                padding: 4px 6px;
                border-radius: 4px;
            }
            .search-form-container-helper .toggle input:checked + .toggle-label {
                background: var(--background-modifier-hover);
            }
            .search-form-container-helper .navigation-buttons {
                display: flex;
                gap: 8px;
                margin-top: 12px;
            }
            .search-form-container-helper .navigation-buttons button {
                flex: 1;
            }
            .search-form-container-helper .search-button {
                background: var(--interactive-accent);
                color: white;
                font-weight: 600;
            }
        `;
        document.head.appendChild(helperStyle);
        
        const formContainer = document.createElement('div');
        formContainer.className = 'search-form-container-helper';
        formContainer.style.cssText = `width: 100%; margin-bottom: 16px;`;
        
        const searchSection = document.createElement('div');
        searchSection.className = 'search-section';
        formContainer.appendChild(searchSection);
        
        const searchTypes = [
            { value: "all", label: "🔍all"}, { value: "file", label: "📄file", icon: "📄" },
            { value: "path", label: "📂path", icon: "📂" }, { value: "tag", label: "🏷️tag", icon: "🏷️" },
            { value: "content", label: "📝content" }, { value: "line", label: "📏line" },
            { value: "block", label: "🧱block" }, { value: "section", label: "📑section" },
            { value: "task", label: "✅task" }, { value: "task-todo", label: "⭕task-todo" },
            { value: "task-done", label: "✔️task-done" }
        ];
        
        const getIconForType = (typeValue) => {
            const found = searchTypes.find(t => t.value === typeValue);
            return found ? found.icon : "🔍";
        };
        
        const createFormRow = () => {
            const row = document.createElement('div');
            row.className = 'form-row';
            row.style.cssText = `display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;`;
            
            const operatorSelect = document.createElement('select');
            operatorSelect.className = 'operator';
            operatorSelect.innerHTML = `<option value="AND">AND</option><option value="OR">OR</option><option value="NOT">NOT</option>`;
            
            const typeSelect = document.createElement('select');
            typeSelect.className = 'type';
            typeSelect.innerHTML = searchTypes.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
            
            const inputGroup = document.createElement('div');
            inputGroup.className = 'input-group';
            inputGroup.style.cssText = `display: flex; flex: 1; min-width: 150px;`;
            
            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.style.cssText = `flex: 1; padding: 6px 8px; border-radius: 4px 0 0 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal);`;
            
            const iconBtn = document.createElement('button');
            iconBtn.className = 'icon-button';
            iconBtn.textContent = '📁';
            iconBtn.style.cssText = `padding: 6px 8px; border-left: none; border-radius: 0 4px 4px 0; background: var(--background-secondary);`;
            
            inputGroup.appendChild(textInput);
            inputGroup.appendChild(iconBtn);
            
            const controls = document.createElement('div');
            controls.className = 'controls';
            controls.innerHTML = `
                <label class="toggle"><input type="checkbox" class="case-sensitive"><span class="toggle-label" title="大小寫敏感">🔤</span></label>
                <label class="toggle"><input type="checkbox" class="diacritics"><span class="toggle-label" title="區分變音符號">◌̈</span></label>
                <label class="toggle"><input type="checkbox" class="regex"><span class="toggle-label" title="正則表達式">.*</span></label>
            `;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-row';
            removeBtn.textContent = '➖';
            
            const addBtn = document.createElement('button');
            addBtn.className = 'add-row';
            addBtn.textContent = '➕';
            
            row.appendChild(operatorSelect);
            row.appendChild(typeSelect);
            row.appendChild(inputGroup);
            row.appendChild(controls);
            row.appendChild(removeBtn);
            row.appendChild(addBtn);
            
            return row;
        };
        
        const addFormRow = () => {
            const newRow = createFormRow();
            searchSection.appendChild(newRow);
            initializeRowEvents(newRow);
            attachFormListeners();
        };
        
        const removeFormRow = (btn) => {
            const row = btn.closest('.form-row');
            if (searchSection.querySelectorAll('.form-row').length > 1) {
                row.remove();
                attachFormListeners();
                updatePreview();
            }
        };
        
        const initializeRowEvents = (row) => {
            const typeSelect = row.querySelector('.type');
            const iconBtn = row.querySelector('.icon-button');
            const inputField = row.querySelector('input[type="text"]');
            
            const updateIcon = () => {
                iconBtn.textContent = getIconForType(typeSelect.value);
            };
            typeSelect.addEventListener('change', updateIcon);
            updateIcon();
            
            // 圖標點擊事件：獲取建議列表
            iconBtn.onclick = async () => {
                const typeValue = typeSelect.value;
                let items = [];
                switch(typeValue) {
                    case 'file':
                        items = this.plugin.app.vault.getMarkdownFiles().map(f => f.basename);
                        break;
                    case 'tag':
                        items = Object.keys(this.plugin.app.metadataCache.getTags());
                        break;
                    case 'path':
                        items = this.plugin.app.vault.getAllFolders().map(f => f.path);
                        break;
                    default:
                        return;
                }
                if (items.length > 0) {
                    items.sort();
                    const choice = await this.plugin.showSuggesterModal(items);
                    if (choice) {
                        if (typeValue === 'tag') {
                            inputField.value += ` ${choice.replace(/                #/, '')}`;
                        } else {
                            inputField.value += ` "${choice}"`;
                        }
                        updatePreview();
                        inputField.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            };
            
            row.querySelector('.add-row').onclick = () => addFormRow();
            row.querySelector('.remove-row').onclick = (e) => removeFormRow(e.currentTarget);
        };

        for (let i = 0; i < 2; i++) {
            const row = createFormRow();
            searchSection.appendChild(row);
            initializeRowEvents(row);
        }
        
        const navButtons = document.createElement('div');
        navButtons.className = 'navigation-buttons';
        navButtons.style.cssText = `display: flex; gap: 8px; margin-top: 12px;`;
        
        const searchBtn = document.createElement('button');
        searchBtn.className = 'search-button';
        searchBtn.textContent = '✍️ 轉入編輯';
        searchBtn.style.cssText = `flex: 1; padding: 8px; background: var(--interactive-accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;`;
        
        const resetBtn = document.createElement('button');
        resetBtn.className = 'reset-button';
        resetBtn.textContent = '🔄 重置';
        resetBtn.style.cssText = `flex: 1; padding: 8px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
        
        navButtons.appendChild(searchBtn);
        navButtons.appendChild(resetBtn);
        formContainer.appendChild(navButtons);
        helperPanel.appendChild(formContainer);
        
        const previewLabel = document.createElement('div');
        previewLabel.textContent = '📋 生成的查詢：';
        previewLabel.style.cssText = `font-size: 12px; margin-top: 12px; margin-bottom: 4px;`;
        helperPanel.appendChild(previewLabel);
        
        const previewArea = document.createElement('div');
        previewArea.style.cssText = `padding: 8px; background: var(--background-secondary); border-radius: 6px; font-family: monospace; font-size: 12px; word-break: break-all; margin-bottom: 16px; max-height: 100px; overflow-y: auto;`;
        helperPanel.appendChild(previewArea);
        
        const generateQueryFromForm = () => {
            const rows = searchSection.querySelectorAll('.form-row');
            const queryParts = [];
            rows.forEach(row => {
                const operator = row.querySelector('.operator').value;
                let type = row.querySelector('.type').value;
                type = type === 'all' ? '' : `${type}:`;
                const input = row.querySelector('input[type="text"]').value.trim();
                const isCaseSensitive = row.querySelector('.case-sensitive').checked;
                const isDiacritics = row.querySelector('.diacritics').checked;
                const isRegex = row.querySelector('.regex').checked;
                if (input) {
                    let searchTerm = input;
                    if (isRegex) searchTerm = `/${searchTerm}/`;
                    else if (type === 'tag:') searchTerm = searchTerm.split(/\s+/).map(t => t.startsWith('#') ? t : `#${t}`).join(' ');
                    else searchTerm = `(${searchTerm})`;
                    let modifiers = '';
                    if (isCaseSensitive) modifiers = 'match-case:' + modifiers;
                    if (isDiacritics) modifiers = 'diacritics:' + modifiers;
                    let queryPart = '';
                    if (queryParts.length === 0) queryPart = `${modifiers}(${type}${searchTerm})`;
                    else {
                        switch (operator) {
                            case 'AND': queryPart = `${modifiers}(${type}${searchTerm})`; break;
                            case 'OR': queryPart = `OR ${modifiers}(${type}${searchTerm})`; break;
                            case 'NOT': queryPart = `-${modifiers}(${type}${searchTerm})`; break;
                        }
                    }
                    queryParts.push(queryPart);
                }
            });
            return queryParts.join(' ');
        };
        
        const updatePreview = () => {
            const query = generateQueryFromForm();
            previewArea.textContent = query || '(空查詢 - 請填寫搜索條件)';
        };
        
        const attachFormListeners = () => {
            const rows = searchSection.querySelectorAll('.form-row');
            rows.forEach(row => {
                const inputs = row.querySelectorAll('input, select');
                inputs.forEach(input => {
                    input.removeEventListener('input', updatePreview);
                    input.removeEventListener('change', updatePreview);
                    input.addEventListener('input', updatePreview);
                    input.addEventListener('change', updatePreview);
                });
            });
        };
        
        const resetForm = () => {
            searchSection.innerHTML = '';
            for (let i = 0; i < 2; i++) {
                const row = createFormRow();
                searchSection.appendChild(row);
                initializeRowEvents(row);
            }
            attachFormListeners();
            updatePreview();
        };
        
        attachFormListeners();
        updatePreview();
        
        searchBtn.onclick = () => {
            const query = generateQueryFromForm();
            if (query && query !== '(空查詢 - 請填寫搜索條件)') {
                queryTextarea.value = query;
                setActiveTab('manual');
                new Notice('✅ 已生成查詢，可繼續編輯');
            } else new Notice('請至少填寫一個搜索條件');
        };
        resetBtn.onclick = resetForm;
        
        contentEl.appendChild(manualPanel);
        contentEl.appendChild(helperPanel);
        
        const bottomButtonRow = document.createElement('div');
        bottomButtonRow.style.cssText = `display: flex; gap: 10px; margin-top: 16px;`;
        
        const submitBtn = document.createElement('button');
        submitBtn.textContent = '🔍 提交搜索';
        submitBtn.style.cssText = `flex: 1; padding: 10px; background: var(--interactive-accent); border: none; border-radius: 8px; cursor: pointer; color: white; font-weight: 600;`;
        submitBtn.onclick = () => {
            let query = '';
            
            // 根據當前活動選項卡決定使用哪個查詢
            if (this.activeTab === 'manual') {
                query = queryTextarea.value.trim();
                if (!query) {
                    new Notice('請在手動編輯區輸入搜索查詢');
                    return;
                }
            } else { // 'helper' 選項卡
                query = generateQueryFromForm();
                if (!query || query === '(空查詢 - 請填寫搜索條件)') {
                    new Notice('請在輔助編輯區填寫至少一個搜索條件');
                    return;
                }
            }
            
            this.close();
            this.plugin.executeNativeSearch(query);
            this.resolveCallback(null);
        };
        bottomButtonRow.appendChild(submitBtn);

        const backBtn = document.createElement('button');
        backBtn.textContent = '返回';  // 「手寫查詢 → 返回主對話框」返回
        backBtn.style.cssText = `flex: 1; padding: 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer;`;
        backBtn.onclick = async () => {
            this.close();
            const prefillAsMultiLine = this.previousFileName && this.previousFileName.includes('\n');
            const result = await this.plugin.showSearchModeDialog(this.previousSearchText, this.previousFileName, prefillAsMultiLine);
            if (result) {
                await this.plugin.executeSearchFromDialogResult(result, { skipHistorySave: false });
            }
            this.resolveCallback(null);
        };
        bottomButtonRow.appendChild(backBtn);

        const helpBtn = document.createElement('button');
        helpBtn.textContent = '📖 幫助';
        helpBtn.style.cssText = `flex: 1; padding: 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer;`;
        helpBtn.onclick = async () => {
            const helpFile = this.plugin.app.vault.getFiles().find(f => f.name === '搜索語法大全.md');
            if (helpFile) {
                const leaf = this.plugin.app.workspace.getLeaf('tab');
                await leaf.openFile(helpFile);
            } else new Notice('未找到「搜索語法大全.md」文件');
        };
        bottomButtonRow.appendChild(helpBtn);
        
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = `flex: 1; padding: 10px; background: transparent; border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer;`;
        cancelBtn.onclick = () => { 
            this.close(); 
            this.resolveCallback(null); 
        };
        bottomButtonRow.appendChild(cancelBtn);
        
        contentEl.appendChild(bottomButtonRow);

        const setActiveTab = (tab) => {
            this.activeTab = tab;
            if (tab === 'manual') {
                manualPanel.style.display = 'block';
                helperPanel.style.display = 'none';
                manualTab.style.color = 'var(--text-normal)';
                manualTab.style.borderBottomColor = 'var(--interactive-accent)';
                helperTab.style.color = 'var(--text-muted)';
                helperTab.style.borderBottomColor = 'transparent';
                submitBtn.textContent = '🔍 提交搜索';  // 保持原樣
            } else {
                manualPanel.style.display = 'none';
                helperPanel.style.display = 'block';
                helperTab.style.color = 'var(--text-normal)';
                helperTab.style.borderBottomColor = 'var(--interactive-accent)';
                manualTab.style.color = 'var(--text-muted)';
                manualTab.style.borderBottomColor = 'transparent';
                attachFormListeners();
                updatePreview();
                submitBtn.textContent = '🔍 提交生成的查詢';  // 更明確的提示
            }
        };

        manualTab.onclick = () => setActiveTab('manual');
        helperTab.onclick = () => setActiveTab('helper');
        
        if (this.prefillQuery) setActiveTab('manual');
        else setTimeout(() => queryTextarea.focus(), 100);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// ==================== 主插件類 ====================
class CustomSearchPlugin extends Plugin {
    async onload() {
        console.log("載入custom-search插件");
        this.currentModal = null; 

        await this.loadSettings();

        this.addSettingTab(new CustomSearchSettingTab(this.app, this));

        // 從 settings 讀取用戶自定義的模式
        this.filePatterns = (this.settings.defaultFilePatterns || []).map(p => {
            try {
                return new RegExp(p);
            } catch(e) {
                console.error(`正則錯誤: ${p}`, e);
                return null;
            }
        }).filter(p => p !== null);

        this.patternStrings = this.filePatterns.map(p => p.source);
        this.pendingRangeInfo = null; // 存儲待處理的文件組信息

        this.registerView(VIEW_TYPE_SEARCH_RESULT, (leaf) => new SearchResultView(leaf, this));

        this.addCommand({
            id: "custom-search-from-selection",
            name: "搜索面板",
            editorCallback: (editor) => this.handleSearch(editor)
        });

        this.addCommand({
            id: "custom-search-quick-preset",
            name: "快速預設範圍搜索",
            editorCallback: (editor) => this.quickPresetSearch(editor)
        });

        this.addCommand({
            id: "custom-search-open-result-panel",
            name: "打開結果面板",
            callback: () => this.activateResultView()
        });

        this.addCommand({
            id: "custom-search-manage-groups",
            name: "管理文件組/組合",
            callback: () => this.showCustomFileGroupsDialog("")
        });

        // 註冊右鍵菜單
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, info) => {
                menu.addItem((item) => {
                    item
                        .setSection("view")
                        .setTitle("搜索面板")
                        .setIcon("lucide-text-search")
                        .onClick(async () => {
                            // 獲取選中文本（可能為空）
                            const selectedText = editor.getSelection().trim();
                            await this.handleSearch(editor);
                        });
                });

                const selectedText = editor.getSelection().trim();
                if (selectedText) {
                    menu.addItem((item) => {
                        item
                            .setSection("view")
                            .setTitle("預設範圍快搜Ctrl+Alt+I")
                            .setIcon("lucide-search-check")
                            .onClick(async () => {
                                // 调用已有的快速预设搜索命令
                                await this.quickPresetSearch(editor);
                            });
                    });
                }
            })
        );

        // 在 onload 方法中添加
        const style = document.createElement('style');
        style.id = 'custom-search-nav-styles';
        style.textContent = `
            .search-result-item-focusable {
                transition: outline 0.1s ease, background-color 0.1s ease;
            }
            .search-result-item-focusable:focus {
                outline: none;
                box-shadow: 0 0 0 2px var(--interactive-accent);
                border-radius: 4px;
            }
            .search-result-item-focusable:focus-within {
                outline: none;
            }
        `;
        document.head.appendChild(style);

        // 在 onunload 中清理
        this.register(() => {
            const s = document.getElementById('custom-search-nav-styles');
            if (s) s.remove();
        });

    }

    // 配置重置
    async loadSettings() {
        // 讀取當前配置
        const loadedData = await this.loadData();
        const oldVersion = loadedData?.version || "0.0.0";
        const currentVersion = DEFAULT_SETTINGS.version;

        // 比較主版本和次版本（忽略修訂版本）
        const isMajorMinorMatch = this.isMajorMinorMatch(oldVersion, currentVersion);
        
        let backupPath = null;
        const configPath = `${this.app.vault.configDir}/plugins/custom-search/data.json`;

        // 如果有配置且主/次版本不匹配，進行備份重置
        if (!isMajorMinorMatch && loadedData && Object.keys(loadedData).length > 0) {
            try {
                const adapter = this.app.vault.adapter;
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                backupPath = `${configPath}.backup.v${oldVersion}.${timestamp}.json`;
                const originalContent = JSON.stringify(loadedData, null, 2);
                await adapter.write(backupPath, originalContent);
                console.log(`[custom-search] 版本不匹配備份已保存至: ${backupPath}`);
            } catch (e) {
                console.error("[custom-search] 備份配置失敗:", e);
            }
            
            // 重置為默認配置
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            await this.saveSettings();
            
            if (backupPath) {
                this.showBackupModal(backupPath);
            }
        } else if (loadedData && Object.keys(loadedData).length > 0) {
            // 有配置且版本兼容，直接使用
            this.settings = loadedData;
            // 如果只有修訂版本不同，更新版本號
            if (oldVersion !== currentVersion) {
                this.settings.version = currentVersion;
                await this.saveSettings();
            }
        } else {
            // 完全沒有配置，創建默認配置
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            await this.saveSettings();
        }

        // 刷新字符寬度緩存
        this.refreshCharWidthCache();
    }

    // 輔助函數：比較主版本和次版本是否相同
    isMajorMinorMatch(oldVer, newVer) {
        const oldParts = String(oldVer).split('.');
        const newParts = String(newVer).split('.');
        return oldParts[0] === newParts[0] && oldParts[1] === newParts[1];
    }

    // 彈窗方法
    showBackupModal(backupPath) {
        const { Modal } = require('obsidian');
        const { exec } = require('child_process');

        class BackupModal extends Modal {
            constructor(app, backupPath) {
                super(app);
                this.backupPath = backupPath;
            }
            
            onOpen() {
                const { contentEl } = this;
                contentEl.empty();
                contentEl.style.padding = '20px';
                contentEl.style.minWidth = '400px';
                
                contentEl.createEl('h3', {
                    text: '⚠️ custom-search版本更新-數據備份警告',
                    attr: { style: 'margin-top: 0; color: var(--text-accent);' }
                });
                
                contentEl.createEl('p', {
                    text: '插件已更新，配置文件已重置為默認值。',
                    attr: { style: 'margin-bottom: 8px;' }
                });
                
                contentEl.createEl('p', {
                    text: '原始配置文件已備份。',
                    attr: { style: 'margin-bottom: 16px;' }
                });
                
                contentEl.createEl('hr', { attr: { style: 'margin: 12px 0;' } });
                
                const pathContainer = contentEl.createEl('div', {
                    attr: { style: 'background: var(--background-secondary); padding: 12px; border-radius: 6px; margin: 12px 0;' }
                });
                
                pathContainer.createEl('div', {
                    text: '📁 備份文件路徑：',
                    attr: { style: 'font-weight: 600; margin-bottom: 8px;' }
                });
                
                pathContainer.createEl('code', {
                    text: this.backupPath,
                    attr: { style: 'display: block; word-break: break-all; font-size: 11px; margin-bottom: 8px; padding: 4px; background: var(--background-primary); border-radius: 4px;' }
                });

                const buttonContainer = pathContainer.createEl('div', {
                    attr: { style: 'display: flex; gap: 8px; margin-top: 4px;' }
                });
                
                const openBackupBtn = buttonContainer.createEl('button', {
                    text: '📂 打開備份文件',
                    attr: { style: 'padding: 4px 12px; font-size: 12px; cursor: pointer; flex: 1;' }
                });
                openBackupBtn.onclick = () => {
                    const adapter = this.app.vault.adapter;
                    const fullPath = adapter.getFullPath(this.backupPath);
                    require('child_process').exec(`start "" "${fullPath}"`);
                };

                const openConfigBtn = buttonContainer.createEl('button', {
                    text: '🗂️ 打開配置文件',
                    attr: { style: 'padding: 4px 12px; font-size: 12px; cursor: pointer; flex: 1;' }
                });
                openConfigBtn.onclick = () => {
                    const adapter = this.app.vault.adapter;
                    const configFullPath = `${this.app.vault.configDir}/plugins/custom-search/data.json`;
                    const fullPath = adapter.getFullPath(configFullPath);
                    require('child_process').exec(`start "" "${fullPath}"`);
                };

                contentEl.createEl('div', {
                    attr: { style: 'font-size: 12px; color: var(--text-muted); margin: 16px 0 12px 0; line-height: 1.6;' }
                }).innerHTML = `
                    💡 如需恢復舊數據，請從備份文件中手動複製配置。<br>
                    💡 <b>恢復方式</b>：<br>
                    &emsp;1. 通過插件設置窗口配置<br>
                    &emsp;2. 對比新版 data.json 格式手動恢復<br>
                    ⚠️ <b>注意</b>：如果修改 data.json 致使格式有誤，可能引起功能失常
                `;

                contentEl.createEl('hr', { attr: { style: 'margin: 12px 0;' } });
                
                const confirmBtn = contentEl.createEl('button', {
                    text: '確認',
                    attr: { style: 'padding: 8px 24px; background: var(--interactive-accent); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; margin-top: 8px;' }
                });
                confirmBtn.onclick = () => this.close();
            }
            
            onClose() {
                const { contentEl } = this;
                contentEl.empty();
            }
        }
        
        new BackupModal(this.app, backupPath).open();
    }

    // 解析範圍字符串，返回 Set
    parseRangesToSet(ranges) {
        const set = new Set();
        for (const range of ranges) {
            if (range.includes('-')) {
                const [startStr, endStr] = range.split('-');
                const start = parseInt(startStr);
                const end = parseInt(endStr);
                for (let code = start; code <= end; code++) {
                    set.add(code);
                }
            } else {
                set.add(parseInt(range));
            }
        }
        return set;
    }

    // 刷新字符寬度緩存（在加載設置或保存設置後調用）
    refreshCharWidthCache() {
        const charWidth = this.settings.charWidth || DEFAULT_SETTINGS.charWidth;
        this.compensatedCharSet = this.parseRangesToSet(charWidth.compensatedRanges);
        this.zeroWidthCharSet = this.parseRangesToSet(charWidth.zeroWidthRanges);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ==================== 公共搜索執行方法 ====================
    /**
     * 統一的搜索執行方法，用於替代重複的 result.type 判斷邏輯
     * @param {Object} result - 對話框返回的結果對象
     * @param {Object} options - 選項
     * @param {boolean} options.skipHistorySave - 是否跳過保存到歷史
     * @param {boolean} options.useEmptyPresetPatterns - preset_a 時是否使用空數組代替 patterns
     * @returns {Promise<void>}
     */
    async executeSearchFromDialogResult(result, options = {}) {
        if (!result) return;
        
        const { skipHistorySave = false, useEmptyPresetPatterns = false } = options;
        
        // 確定 patterns
        let patterns;
        if (result.type === 'preset_a' || result.type === 'preset_b') {
            if (useEmptyPresetPatterns && result.type === 'preset_a') {
                patterns = [];
            } else {
                patterns = result.presetPatterns || this.filePatterns;
            }
        } else {
            patterns = result.fileName;
        }
        
        const isPreset = result.type === 'preset_a' || result.type === 'preset_b';
        const isSidebar = result.type === 'preset_a' || result.type === 'custom_a';
        
        if (isSidebar) {
            await this.searchAndShowInSidebar(
                result.searchText,
                patterns,
                isPreset,
                result.rangeDisplay,
                skipHistorySave,
                result.rangeRef,
                result.isBooleanQuery || false,
                result.enableDiacriticIgnore || false,
                result.enableHtmlTagIgnore || false
            );
        } else {
            this.executeNativeSearchWithPatterns(
                result.searchText,
                patterns,
                isPreset,
                result.isBooleanQuery || false
            );
        }
    }

    showSuggesterModal(items) {
        const { FuzzySuggestModal } = require('obsidian');
        
        return new Promise((resolve) => {
            class SimpleSuggestModal extends FuzzySuggestModal {
                constructor(app, items, resolveFunc) {
                    super(app);
                    this.items = items;
                    this.resolveFunc = resolveFunc;
                }
                
                getItems() {
                    return this.items;
                }
                
                getItemText(item) {
                    return item;
                }
                
                onChooseItem(item) {
                    this.resolveFunc(item);
                }
            }
            
            const modal = new SimpleSuggestModal(this.app, items, resolve);
            modal.open();
        });
    }

    // ==================== 搜索函數 ====================
    
    async searchInFiles(fileNameRegexArray, contentRegex, highlightRegex) {
        // ===== 可中斷搜索常量 =====
        const SLOW_SEARCH_THRESHOLD = 2000;  // 2秒彈窗閾值
        const STOP_CHECK_INTERVAL = 150;     // 彈窗後每150ms檢查一次停止標志

        const allFiles = this.app.vault.getMarkdownFiles();
        const results = [];
        
        // 可中斷搜索狀態
        let shouldStop = false;           // 用戶是否要求停止
        let hasShownSlowDialog = false;   // 是否已彈過窗
        let slowDialogNotice = null;      // 彈窗引用
        let isMonitoringStop = false;     // 是否已開始監控停止標志（彈窗後才啟用）
        let lastStopCheckTime = 0;        // 上次檢查停止標志的時間

        // 2秒後檢查是否需要彈窗
        const slowTimer = setTimeout(() => {
            if (!shouldStop && !hasShownSlowDialog) {
                hasShownSlowDialog = true;
                
                // 創建自定義懸浮彈窗（非模態，不阻塞用戶操作）
                const customNotice = document.createElement('div');
                customNotice.className = 'custom-search-slow-notice';
                customNotice.style.cssText = `
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    z-index: 10000;
                    background: var(--background-primary);
                    border: 1px solid var(--background-modifier-border);
                    border-radius: 8px;
                    padding: 12px 16px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    min-width: 260px;
                `;
                
                const messageEl = customNotice.createEl('div', {
                    text: '⏳ 搜索已運行超過2秒，是否繼續？',
                    attr: { style: 'font-size: 13px;' }
                });
                
                const buttonDiv = customNotice.createEl('div', {
                    attr: { style: 'display: flex; gap: 8px; justify-content: flex-end;' }
                });
                
                const continueBtn = buttonDiv.createEl('button', {
                    text: '繼續',
                    attr: { style: 'padding: 4px 12px; cursor: pointer;' }
                });
                
                const stopBtn = buttonDiv.createEl('button', {
                    text: '停止',
                    attr: { style: 'padding: 4px 12px; cursor: pointer; background: var(--background-modifier-error); color: white; border: none;' }
                });
                
                // 繼續按鈕點擊事件
                continueBtn.onclick = () => {
                    // 啟用停止標志監控
                    isMonitoringStop = true;
                    lastStopCheckTime = Date.now();
                    // 更新彈窗內容，但不關閉
                    messageEl.textContent = '🔍 搜索仍在進行中...';
                    continueBtn.disabled = true;
                    continueBtn.style.opacity = '0.5';
                    // 停止按鈕保持可用
                };
                
                // 停止按鈕點擊事件
                stopBtn.onclick = () => {
                    shouldStop = true;
                    customNotice.remove();
                    new Notice('⏹️ 搜索已取消，將顯示已找到的結果');
                };
                
                // 添加到頁面
                document.body.appendChild(customNotice);
                
                // 保存引用以便清理
                slowDialogNotice = { hide: () => customNotice.remove() };
            }
        }, SLOW_SEARCH_THRESHOLD);

        // 判斷是否為包含排除信息的對象
        let includePatterns, excludePatterns, mode;
        if (fileNameRegexArray && typeof fileNameRegexArray === 'object' && fileNameRegexArray.includePatterns !== undefined) {
            includePatterns = fileNameRegexArray.includePatterns;
            excludePatterns = fileNameRegexArray.excludePatterns;
            mode = fileNameRegexArray.mode;
        } else {
            includePatterns = fileNameRegexArray;
            excludePatterns = [];
            mode = 'include-only';
        }
    
        const includePatternsInfo = includePatterns.map(pattern => ({
            regex: pattern,
            isPathPattern: pattern.source.includes('/')
        }));
        
        const excludePatternsInfo = excludePatterns.map(pattern => ({
            regex: pattern,
            isPathPattern: pattern.source.includes('/')
        }));
    
        // 根據模式選擇文件過濾邏輯
        let targetFiles = [];
        
        if (mode === 'include-only') {
            // 原有行為：只匹配包含模式
            targetFiles = allFiles.filter(file => {
                for (const info of includePatternsInfo) {
                    const target = info.isPathPattern ? file.path : file.name;
                    if (info.regex.test(target)) {
                        return true;
                    }
                }
                return false;
            });
        } else if (mode === 'exclude-only') {
            // 只有排除：從所有文件中排除匹配排除模式的文件
            targetFiles = allFiles.filter(file => {
                for (const info of excludePatternsInfo) {
                    const target = info.isPathPattern ? file.path : file.name;
                    if (info.regex.test(target)) {
                        return false;
                    }
                }
                return true;
            });
        } else if (mode === 'exclude-first') {
            // 先排除，再選取包含
            const afterExclude = allFiles.filter(file => {
                for (const info of excludePatternsInfo) {
                    const target = info.isPathPattern ? file.path : file.name;
                    if (info.regex.test(target)) {
                        return false;
                    }
                }
                return true;
            });
            targetFiles = afterExclude.filter(file => {
                for (const info of includePatternsInfo) {
                    const target = info.isPathPattern ? file.path : file.name;
                    if (info.regex.test(target)) {
                        return true;
                    }
                }
                return false;
            });
        } else if (mode === 'exclude-last') {
            // 先選取包含，再從中排除
            const afterInclude = allFiles.filter(file => {
                for (const info of includePatternsInfo) {
                    const target = info.isPathPattern ? file.path : file.name;
                    if (info.regex.test(target)) {
                        return true;
                    }
                }
                return false;
            });
            targetFiles = afterInclude.filter(file => {
                for (const info of excludePatternsInfo) {
                    const target = info.isPathPattern ? file.path : file.name;
                    if (info.regex.test(target)) {
                        return false;
                    }
                }
                return true;
            });
        }
        
        targetFiles.sort((a, b) => a.path.localeCompare(b.path));
    
        if (targetFiles.length === 0) {
            new Notice(`📭 未找到文件名匹配的文件`);
            return null;
        }
        
        // new Notice(`找到 ${targetFiles.length} 個文件，正在搜索...`);
        
        for (let fileIdx = 0; fileIdx < targetFiles.length; fileIdx++) {
            const file = targetFiles[fileIdx];
            
            // 僅在彈窗後（啟用了監控）才檢查停止標志
            if (isMonitoringStop) {
                const now = Date.now();
                if (now - lastStopCheckTime >= STOP_CHECK_INTERVAL) {
                    lastStopCheckTime = now;
                    if (shouldStop) {
                        clearTimeout(slowTimer);
                        if (slowDialogNotice) {
                            slowDialogNotice.hide();
                            slowDialogNotice = null;
                        }
                        // 返回已找到的結果
                        let finalHighlightRegex = highlightRegexForContent;
                        if (!finalHighlightRegex && contentRegex) {
                            finalHighlightRegex = this.extractHighlightRegex(contentRegex);
                        }
                        if (results.length > 0) {
                            new Notice(`⏹️ 搜索已停止，已顯示 ${results.length} 處匹配（${targetFiles.length} 個文件中已完成 ${fileIdx} 個）`);
                        } else {
                            new Notice(`⏹️ 搜索已停止，未找到任何匹配`);
                        }
                        return { results, targetFilesCount: targetFiles.length, highlightRegex: finalHighlightRegex };
                    }
                }
            }
            
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                let match = false;
                
                // 使用已生成的正則進行匹配
                if (contentRegex) {
                    match = contentRegex.test(line);
                } else {
                    match = false;
                }
                
                if (match) {
                    results.push({
                        file: file.path,
                        lineNumber: i + 1,
                        lineContent: line.trim()
                    });
                }
            }
        }
        
        // 清理計時器
        clearTimeout(slowTimer);
        if (slowDialogNotice) {
            slowDialogNotice.hide();
            slowDialogNotice = null;
        }
        
        return { results, targetFilesCount: targetFiles.length, highlightRegex: highlightRegex };
    }

    /**
     * 解析布爾查詢表達式，轉換為正則表達式
     * 支持運算符：空格 = AND, & = AND, | = OR, ! = NOT
     * 支持括號分組：( )
     * 支持轉義：\&, \|, \!, \(, \)
     * @param {string} query - 用戶輸入的查詢字符串
     * @param {boolean} enableDiacriticIgnore - 是否啟用變音符號忽略
     * @returns {RegExp|null} 生成的正則表達式
     */
    parseBooleanQuery(query, enableDiacriticIgnore = false) {
        if (!query || !query.trim()) return null;
        
        // 轉義處理
        const escapedMap = new Map();
        let counter = 0;
        let processed = query.replace(/\\([&|!()])/g, (match, char) => {
            const placeholder = `__ESC_${counter++}__`;
            escapedMap.set(placeholder, char);
            return placeholder;
        });
        
        // 解析表達式
        const regexPattern = this.parseBooleanExpr(processed);
        if (!regexPattern) return null;
        
        // 恢復轉義字符
        let finalPattern = regexPattern;
        for (const [placeholder, char] of escapedMap) {
            finalPattern = finalPattern.replace(new RegExp(placeholder, 'g'), `\\${char}`);
        }
        
        // 應用變音符號忽略轉換
        if (enableDiacriticIgnore) {
            finalPattern = convertRegexToIgnoreDiacritics(finalPattern);
        }
        
        try {
            return new RegExp(finalPattern, 'i');
        } catch (e) {
            console.error(`布爾查詢正則生成錯誤: ${finalPattern}`, e);
            return null;
        }
    }

    /**
     * 從正則表達式中提取用於高亮的關鍵詞正則
     * @param {RegExp} regex - 搜索用的正則表達式
     * @returns {RegExp|null} 用於高亮的正則（全局不區分大小寫）
     */
    extractHighlightRegex(regex) {
        if (!regex) return null;
        
        const source = regex.source;
        
        // 檢查是否有零寬斷言（向前查找）
        const hasLookahead = source.includes('(?=') || source.includes('(?!');
        
        if (!hasLookahead) {
            // 沒有零寬斷言，直接返回原正則（轉為全局不區分大小寫）
            return new RegExp(source, 'gi');
        }
        
        // 有零寬斷言，提取關鍵詞
        const keywords = this.extractKeywordsFromRegex(source);
        if (keywords.length === 0) {
            return null;
        }
        
        // 合併關鍵詞為 OR 正則
        const escapedKeywords = keywords.map(k => this.escapeRegexForHighlight(k));
        return new RegExp(escapedKeywords.join('|'), 'gi');
    }
    
    /**
     * 從正則表達式中提取字面關鍵詞（處理零寬斷言）
     * @param {string} source - 正則表達式源碼
     * @returns {string[]} 提取的關鍵詞數組
     */
    extractKeywordsFromRegex(source) {
        const keywords = new Set();
        
        // 匹配 (?=.*關鍵詞) 或 (?!.*關鍵詞) 模式
        // 捕獲關鍵詞部分（支持中英文、數字、下劃線）
        const lookaheadPattern = /\(\?[=!]\.\*([^)]+)\)/g;
        let match;
        
        while ((match = lookaheadPattern.exec(source)) !== null) {
            let keywordPart = match[1];
            
            // 處理 OR 表達式 (A|B)
            if (keywordPart.includes('|')) {
                const parts = keywordPart.split('|');
                for (const part of parts) {
                    const cleaned = this.cleanKeyword(part);
                    if (cleaned) keywords.add(cleaned);
                }
            } else {
                const cleaned = this.cleanKeyword(keywordPart);
                if (cleaned) keywords.add(cleaned);
            }
        }
        
        // 如果沒從零寬斷言中提取到，嘗試從整個正則中提取字面量
        if (keywords.size === 0) {
            const literalPattern = /[^\\][\u4e00-\u9fa5a-zA-Z0-9]+/g;
            let literalMatch;
            while ((literalMatch = literalPattern.exec(source)) !== null) {
                const literal = literalMatch[0].replace(/^\\(.)/, '$1');
                if (literal && literal.length > 0) {
                    keywords.add(literal);
                }
            }
        }
        
        return Array.from(keywords);
    }
    
    /**
     * 清理關鍵詞（移除正則元字符）
     * @param {string} str - 原始字符串
     * @returns {string} 清理後的關鍵詞
     */
    cleanKeyword(str) {
        if (!str) return '';
        // 移除常見的正則元字符
        let cleaned = str.replace(/[.*+?^${}()|[\]\\]/g, '');
        // 移除引號
        cleaned = cleaned.replace(/["']/g, '');
        return cleaned.trim();
    }
    
    /**
     * 轉義正則特殊字符（用於高亮）
     * @param {string} str - 原始字符串
     * @returns {string} 轉義後的字符串
     */
    escapeRegexForHighlight(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * 遞迴解析布爾表達式
     * @param {string} expr - 表達式字符串
     * @returns {string} 正則表達式模式
     */
    parseBooleanExpr(expr) {
        expr = expr.trim();
        if (!expr) return null;
        
        // 處理括號分組
        let depth = 0;
        let lastStart = -1;
        const groups = [];
        let current = '';
        
        for (let i = 0; i < expr.length; i++) {
            const ch = expr[i];
            if (ch === '(') {
                if (depth === 0) {
                    if (current.trim()) {
                        groups.push({ type: 'term', value: current.trim() });
                        current = '';
                    }
                    lastStart = i;
                }
                depth++;
            } else if (ch === ')') {
                depth--;
                if (depth === 0 && lastStart !== -1) {
                    const subExpr = expr.substring(lastStart + 1, i);
                    const subPattern = this.parseBooleanExpr(subExpr);
                    if (subPattern) {
                        groups.push({ type: 'group', value: subPattern });
                    }
                    lastStart = -1;
                }
            } else if (depth === 0) {
                current += ch;
            }
        }
        if (current.trim()) {
            groups.push({ type: 'term', value: current.trim() });
        }
        
        if (groups.length === 0) return null;
        
        // 處理每個組
        const processedGroups = groups.map(group => {
            if (group.type === 'group') return group.value;
            return this.parseBooleanTerm(group.value);
        });
        
        if (processedGroups.length === 1) return processedGroups[0];
        
        // 用 OR 連接（頂層 |）
        return `(${processedGroups.join('|')})`;
    }

    /**
     * 解析一個術語（處理 AND 和 NOT）
     * @param {string} term - 術語字符串
     * @returns {string} 正則表達式模式
     */
    parseBooleanTerm(term) {
        term = term.trim();
        if (!term) return null;
        
        // 分割 AND 條件（空格和 &）
        const parts = [];
        let current = '';
        let inQuote = false;
        
        for (let i = 0; i < term.length; i++) {
            const ch = term[i];
            if (ch === '"') {
                inQuote = !inQuote;
                current += ch;
            } else if ((ch === ' ' || ch === '&') && !inQuote) {
                if (current.trim()) {
                    parts.push(current.trim());
                    current = '';
                }
                // 跳過連續的空格或 &
                while (i + 1 < term.length && (term[i + 1] === ' ' || term[i + 1] === '&')) i++;
            } else {
                current += ch;
            }
        }
        if (current.trim()) {
            parts.push(current.trim());
        }
        
        // 處理 NOT 和 OR
        const processedParts = [];
        let i = 0;
        while (i < parts.length) {
            let part = parts[i];
            if (part === '!') {
                if (i + 1 < parts.length) {
                    const nextPart = parts[i + 1];
                    processedParts.push(`(?!.*${this.escapeRegexForBoolean(nextPart)})`);
                    i += 2;
                } else {
                    i++;
                }
            } else if (part.startsWith('!')) {
                const word = part.substring(1);
                processedParts.push(`(?!.*${this.escapeRegexForBoolean(word)})`);
                i++;
            } else {
                // 處理內部的 OR (|)
                const orParts = part.split('|').map(p => this.escapeRegexForBoolean(p.trim()));
                if (orParts.length > 1) {
                    processedParts.push(`(${orParts.join('|')})`);
                } else {
                    processedParts.push(this.escapeRegexForBoolean(part));
                }
                i++;
            }
        }
        
        if (processedParts.length === 0) return null;
        if (processedParts.length === 1) return processedParts[0];
        
        // AND 連接
        let result = '';
        for (const part of processedParts) {
            if (part.startsWith('(?!')) {
                result += part;
            } else {
                result += `(?=.*${part})`;
            }
        }
        return `^${result}.*$`;
    }
    
    /**
     * 轉義正則特殊字符（用於布爾查詢）
     * @param {string} str - 原始字符串
     * @returns {string} 轉義後的字符串
     */
    escapeRegexForBoolean(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ==================== 文件組相關函數 ====================
    // 加載文件組數據（從 settings 中讀取）
    async loadCustomFileGroups() {
        // 確保 settings 中有 fileGroups 結構
        if (!this.settings.fileGroups) {
            this.settings.fileGroups = { groups: {}, combinations: {}, defaultPreset: null };
        }
        if (!this.settings.fileGroups.groups) this.settings.fileGroups.groups = {};
        if (!this.settings.fileGroups.combinations) this.settings.fileGroups.combinations = {};
        
        return this.settings.fileGroups;
    }
    
    // 保存文件組數據（保存到 settings）
    async saveCustomFileGroups(data) {
        this.settings.fileGroups = data;
        await this.saveSettings();
        return true;
    }

    // ==================== 結果顯示函數（替代原來的 searchAndGenerateFile） ====================
    
    async searchAndShowInSidebar(searchText, fileNamePatterns, isPreset, rangeDisplay = null, skipHistorySave = false, rangeRef = null, isBooleanQuery = false, enableDiacriticIgnore = false, enableHtmlTagIgnore = false) {
        const isRegex = isRegexPattern(searchText);

        // 使用新的解析函數獲取包含排除信息的對象
        let patternsForSearch;
        if (isPreset) {
            // 預設範圍：每次動態解析（確保設置修改後立即生效）
            const defaultPatternsText = (this.settings.defaultFilePatterns || []).join('\n');
            patternsForSearch = parsePatternsWithExcludes(defaultPatternsText);
        } else {
            patternsForSearch = parsePatternsWithExcludes(fileNamePatterns);
        }

        // 檢查是否有有效的包含或排除模式
        if (patternsForSearch.includePatterns.length === 0 && patternsForSearch.excludePatterns.length === 0) {
            new Notice(`❌ 沒有有效的文件名模式`);
            return false;
        }

        // 在調用 searchInFiles 之前，根據模式生成 contentRegex 和 highlightRegex
        let contentRegex = null;
        let highlightRegexForContent = null;
        const isRegexContent = isRegex;
        
        // 輔助函數：在正則的每個字符之間插入標籤/標點忽略模式
        const insertTagIgnorePattern = (regexSource) => {
            if (!enableHtmlTagIgnore) return regexSource;
            if (isBooleanQuery) return regexSource;  // 布爾模式不應用（已通過互斥保證不會同時啟用）
            if (isRegexContent) return regexSource;  // 正則模式不應用（已通過互斥保證不會同時啟用）
            
            const tagPunctuationPattern = '(?:<[^>]*>|\\p{P}|\\p{S}){0,6}'; // html標簽、標點、md語法*^~`=_[].()
            let result = '';
            let i = 0;
            const len = regexSource.length;
            let inCharClass = false;
            let charClassContent = '';
            
            while (i < len) {
                const ch = regexSource[i];
                const prevCh = i > 0 ? regexSource[i - 1] : '';
                const isEscaped = prevCh === '\\';
                
                // 處理轉義字符：跳過下一個字符
                if (ch === '\\' && !isEscaped) {
                    result += ch;
                    i++;
                    if (i < len) {
                        result += regexSource[i];
                        i++;
                    }
                    continue;
                }
                
                // 處理字符組邊界
                if (ch === '[' && !isEscaped) {
                    if (inCharClass) {
                        charClassContent += ch;
                    } else {
                        inCharClass = true;
                        charClassContent = '';
                    }
                    result += ch;
                    i++;
                    continue;
                }
                
                if (ch === ']' && !isEscaped && inCharClass) {
                    inCharClass = false;
                    result += ch;
                    i++;
                    continue;
                }
                
                // 在字符組內部，原樣輸出
                if (inCharClass) {
                    result += ch;
                    i++;
                    continue;
                }
                
                // 普通字符：輸出當前字符，然後如果不是最後一個字符，插入忽略模式
                result += ch;
                if (i + 1 < len) {
                    // 檢查下一個字符是否為量詞或特殊字符
                    const nextCh = regexSource[i + 1];
                    if (!'*+?{}'.includes(nextCh)) {
                        result += tagPunctuationPattern;
                    }
                }
                i++;
            }
            
            return result;
        };

        // 根據模式生成忽略變音符號的正則
        if (isBooleanQuery) {
            // 布爾模式：先轉正則，再轉換
            const booleanRegex = this.parseBooleanQuery(searchText, enableDiacriticIgnore);
            if (booleanRegex) {
                contentRegex = booleanRegex;
                highlightRegexForContent = this.extractHighlightRegex(contentRegex);
            } else {
                return false;
            }
        } else if (isRegexContent) {
            // 正則模式：直接轉換用戶輸入的正則（不應用無視標籤，通過互斥保證不會同時啟用）
            let finalSource = searchText;
            if (enableDiacriticIgnore) {
                finalSource = convertRegexToIgnoreDiacritics(searchText);
            }
            try {
                contentRegex = new RegExp(finalSource, 'iu');
                highlightRegexForContent = this.extractHighlightRegex(contentRegex);
            } catch (e) {
                new Notice(`❌ 內容正則表達式錯誤：${e.message}`);
                return false;
            }
        } else {
            // 普通文本模式：轉換為正則後搜索
            let finalPattern;
            if (enableDiacriticIgnore) {
                finalPattern = convertPlainTextToIgnoreDiacritics(searchText);
            } else {
                finalPattern = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }

            // 「無視標籤」，先刪除指定標點，再應用標籤/標點忽略模式
            if (enableHtmlTagIgnore) {
                // 先刪除指定標點
                // 定義要去掉的標點字符集合
                // 中文標點：，。、；：？！「」『』（）【】
                // 英文標點：,.;:?!   ---()\[\]{}<>\/|\\`~@#$%^&*_=+ 
                // 普通文本模式下，所有標點都是字面字符，直接刪除即可
                // const punctuationToRemoveA = /[，。、；：？！「」『』（）【】,.;:?!]/g; // 備用A：删除指定标点
                const punctuationToRemoveB = /<[^>]*>|[\p{P}\p{S}]/gu; // 備用B：删除 HTML 标签、所有标点、所有符号
                finalPattern = finalPattern.replace(punctuationToRemoveB, '');
                // 再插入忽略模式
                finalPattern = insertTagIgnorePattern(finalPattern);
            }

            try {
                contentRegex = new RegExp(finalPattern, 'iu');
                // 高亮用正則：直接使用搜索正則（會連帶高亮標籤和標點，可接受）
                highlightRegexForContent = new RegExp(contentRegex.source, 'giu');
            } catch (e) {
                new Notice(`❌ 文本轉正則錯誤：${e.message}`);
                return false;
            }
        }

        const searchResult = await this.searchInFiles(patternsForSearch, contentRegex, highlightRegexForContent);

        if (searchResult === null) return false;
        
        // 構建統計字串
        let statsText = "";
        if (rangeDisplay) {
            statsText = `${rangeDisplay} | 文件：${searchResult.targetFilesCount}`;
        } else if (isPreset) {
            statsText = `預定範圍 | 文件：${searchResult.targetFilesCount}`;
        } else {
            statsText = `自定義範圍（${patternsForSearch.includePatterns.length + patternsForSearch.excludePatterns.length}個模式） | 文件：${searchResult.targetFilesCount}`;
        }

        // 獲取模式數組（用於排序）
        let patternsArray = patternsForSearch.includePatterns;
        
        // 生成 patternsText（用於保存歷史）
        let patternsText = "";
        if (isPreset) {
            // 如果是預設範圍，嘗試獲取原始模式文本
            if (Array.isArray(fileNamePatterns)) {
                patternsText = fileNamePatterns.map(p => p.source).join('\n');
            } else {
                patternsText = fileNamePatterns;
            }
        } else {
            patternsText = fileNamePatterns;
        }
        
        const view = await this.activateResultView();
        if (view) {
            // 只有非歷史加載時才標記為主動搜索
            if (!skipHistorySave) {
                view.markAsActiveSearch();
            }
            view.updateResults(searchText, searchResult.results, isRegex, statsText, patternsArray, patternsText, isPreset, rangeDisplay, rangeRef, isBooleanQuery, searchResult.highlightRegex, enableDiacriticIgnore, enableHtmlTagIgnore);
        }

        return true;
    }

    async activateResultView() {
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH_RESULT)[0];
        if (!leaf) {
            const rightLeaf = this.app.workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({ type: VIEW_TYPE_SEARCH_RESULT, active: true });
                leaf = rightLeaf;
            }
        }
        if (leaf) {
            this.app.workspace.revealLeaf(leaf);
            return leaf.view;
        }
        return null;
    }

    executeNativeSearch(query) {
        // 設置搜索輸入框的值
        const searchInput = document.querySelector('.search-input-container > input');
        if (searchInput) {
            searchInput.value = query;
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        // 執行搜索命令
        this.app.commands.executeCommandById("search:search");
         // 代替 searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
         // 避免了 Enter 事件的模擬問題，不需要加括號的 workaround ---排除模式不需要再用括號包起來
        
        const isCollapsed = document.querySelector('.workspace-split.mod-right-split.is-sidedock-collapsed');
        if (isCollapsed) this.app.commands.executeCommandById("app:toggle-right-sidebar");
        
        this.app.workspace.getLeavesOfType('search').forEach(leaf => {
            this.app.workspace.setActiveLeaf(leaf, { focus: true });
        });
    }

    executeNativeSearchWithPatterns(searchText, fileNamePatterns, isPreset, isBooleanQuery = false) {
        // 如果是预设模式且 fileNamePatterns 为空，从设置中读取默认模式
        let patternsToUse = fileNamePatterns;
        if (isPreset && (!fileNamePatterns || fileNamePatterns.length === 0)) {
            patternsToUse = this.filePatterns;  // 使用插件加载的默认模式
        }
        const searchQuery = buildNativeSearchQuery(searchText, patternsToUse, isPreset, isBooleanQuery);
        if (!searchQuery) {
            new Notice(`❌ 沒有有效的文件名模式`);
            return;
        }
        this.executeNativeSearch(searchQuery);
    }

    // 將歷史條目恢復到搜索對話框（不執行搜索）
    async restoreHistoryToDialog(historyItem) {
        if (!historyItem) return false;
        
        // 數據修正：確保字段完整
        let needsSave = false;
        if (historyItem.isBooleanQuery === undefined) {
            historyItem.isBooleanQuery = false;
            needsSave = true;
        }
        if (historyItem.isRegex === undefined) {
            historyItem.isRegex = false;
            needsSave = true;
        }
        if (historyItem.enableDiacriticIgnore === undefined) {
            historyItem.enableDiacriticIgnore = false;
            needsSave = true;
        }
        if (historyItem.enableHtmlTagIgnore === undefined) {
            historyItem.enableHtmlTagIgnore = false;
            needsSave = true;
        }
        if (!historyItem.rangeRef) {
            historyItem.rangeRef = { type: "default", name: null, patternsText: null };
            needsSave = true;
        }
        
        if (needsSave) {
            await this.saveSettings();
        }
        
        const searchText = historyItem.searchText;
        const rangeRef = historyItem.rangeRef;
        const isBooleanQuery = historyItem.isBooleanQuery || false;
        const enableDiacriticIgnore = historyItem.enableDiacriticIgnore || false;
        const enableHtmlTagIgnore = historyItem.enableHtmlTagIgnore || false;
        
        // 根據 rangeRef 類型準備恢復參數
        let patternsTextToRestore = "";
        let prefillAsMultiLine = false;
        let restoreRangeRef = rangeRef;
        
        if (rangeRef.type === "default") {
            // 預設範圍：不需要 patterns 文本
            patternsTextToRestore = "";
            prefillAsMultiLine = false;
        } else if (rangeRef.type === "group" && !rangeRef.patternsText) {
            // 未修改的文件組：從 groups 中讀取
            const groups = this.settings.fileGroups?.groups || {};
            const group = groups[rangeRef.name];
            if (group && group.patterns) {
                patternsTextToRestore = group.patterns.join('\n');
                prefillAsMultiLine = true;
            } else {
                new Notice(`文件組「${rangeRef.name}」不存在`);
                return false;
            }
        } else if (rangeRef.type === "combination" && !rangeRef.patternsText) {
            // 未修改的組合：從 combinations 中讀取
            const groups = this.settings.fileGroups?.groups || {};
            const combinations = this.settings.fileGroups?.combinations || {};
            const combo = combinations[rangeRef.name];
            if (combo && combo.groups) {
                const allPatterns = [];
                for (const groupName of combo.groups) {
                    const group = groups[groupName];
                    if (group && group.patterns) {
                        allPatterns.push(...group.patterns);
                    }
                }
                if (allPatterns.length > 0) {
                    patternsTextToRestore = allPatterns.join('\n');
                    prefillAsMultiLine = true;
                } else {
                    new Notice(`組合「${rangeRef.name}」無效`);
                    return false;
                }
            } else {
                new Notice(`組合「${rangeRef.name}」不存在`);
                return false;
            }
        } else if (rangeRef.patternsText) {
            // 修改版或自定義：直接使用 patternsText
            patternsTextToRestore = rangeRef.patternsText;
            prefillAsMultiLine = true;
        } else {
            patternsTextToRestore = "";
            prefillAsMultiLine = false;
        }
        
        // 打開對話框並恢復狀態
        const result = await this.showSearchModeDialog(
            searchText,
            patternsTextToRestore,
            prefillAsMultiLine,
            restoreRangeRef,  // 傳入 rangeRef 用於恢復組/組合狀態
            isBooleanQuery,
            enableDiacriticIgnore,
            enableHtmlTagIgnore
        );

        // 如果用戶在對話框中提交了搜索，則執行搜索
        if (result) {
            await this.plugin.executeSearchFromDialogResult(result, { skipHistorySave: true });
        }
        
        return true;
    }

    // 更新當前對話框的內容（不重建對話框）
    async updateCurrentDialogWithHistory(historyItem, dialogRefs) {
        if (!historyItem) return false;
        
        // 數據修正：確保字段完整
        let needsSave = false;
        if (historyItem.isBooleanQuery === undefined) {
            historyItem.isBooleanQuery = false;
            needsSave = true;
        }
        if (historyItem.isRegex === undefined) {
            historyItem.isRegex = false;
            needsSave = true;
        }
        if (historyItem.enableDiacriticIgnore === undefined) {
            historyItem.enableDiacriticIgnore = false;
            needsSave = true;
        }
        if (!historyItem.rangeRef) {
            historyItem.rangeRef = { type: "default", name: null, patternsText: null };
            needsSave = true;
        }
        
        if (needsSave) {
            await this.saveSettings();
        }
        
        const searchText = historyItem.searchText;
        const rangeRef = historyItem.rangeRef;
        const isBooleanQuery = historyItem.isBooleanQuery || false;
        const enableDiacriticIgnore = historyItem.enableDiacriticIgnore || false;
        const enableHtmlTagIgnore = historyItem.enableHtmlTagIgnore || false;
        
        // 解構對話框引用
        const {
            searchTextInput,
            booleanQueryCheckbox,
            diacriticIgnoreCheckbox,
            htmlTagIgnoreCheckbox,
            singleLineInput,
            multiLineTextarea,
            isExpanded,
            expandToMultiLine,
            autoResizeTextarea,
            clearCustomButtonState,
            setCustomButtonState,
            updateButtonHighlight,
            getFileNamePatterns,
            customButtonState,
            pendingRangeInfo,
            state  // 添加這一行
        } = dialogRefs;
        
        // 1. 更新搜索內容
        searchTextInput.value = searchText;
        // 2. 更新開關：布爾模式、無視標籤、忽略變音
        booleanQueryCheckbox.checked = isBooleanQuery;
        htmlTagIgnoreCheckbox.checked = enableHtmlTagIgnore;
        diacriticIgnoreCheckbox.checked = enableDiacriticIgnore;
        // 3. 依次觸發 change 事件，執行互斥邏輯
        const boolEvent = new Event('change');
        const tagEvent = new Event('change');
        const diaEvent = new Event('change');
        booleanQueryCheckbox.dispatchEvent(boolEvent);
        htmlTagIgnoreCheckbox.dispatchEvent(tagEvent);
        diacriticIgnoreCheckbox.dispatchEvent(diaEvent);
        // 觸發 input 事件以重新檢測正則模式
        searchTextInput.dispatchEvent(new Event('input'));

        // 4. 根據 rangeRef 類型更新編輯區和自定義範圍狀態
        if (rangeRef.type === "default") {
            // 預設範圍：清空編輯區，收起多行模式，清除自定義範圍狀態
            singleLineInput.value = '';
            multiLineTextarea.value = '';
            
            // 從 DOM 實時判斷是否需要收起
            const isActuallyExpanded = multiLineTextarea.style.display === 'block';
            if (isActuallyExpanded) {
                multiLineTextarea.style.display = 'none';
                singleLineInput.style.display = 'block';
            }
            
            // 清除自定義範圍按鈕的 📌 狀態
            if (clearCustomButtonState) {
                clearCustomButtonState();
            }
            // 更新按鈕高亮
            if (updateButtonHighlight) {
                updateButtonHighlight();
            }
            // 清除 pendingRangeInfo
            this.pendingRangeInfo = null;
        }
        else if (rangeRef.type === "group" || rangeRef.type === "combination") {
            // 文件組或組合：需要獲取 patterns 並填充編輯區
            let patternsArray = [];
            let rangeType = "";
            let originalPatternsText = "";
            
            if (rangeRef.type === "group" && !rangeRef.patternsText) {
                // 未修改的文件組：從 groups 中讀取
                const groups = this.settings.fileGroups?.groups || {};
                const group = groups[rangeRef.name];
                if (group && group.patterns) {
                    patternsArray = group.patterns;
                    rangeType = "文件組";
                    originalPatternsText = patternsArray.join('\n');
                } else {
                    new Notice(`文件組「${rangeRef.name}」不存在`);
                    return false;
                }
            } else if (rangeRef.type === "combination" && !rangeRef.patternsText) {
                // 未修改的組合：從 combinations 中讀取
                const groups = this.settings.fileGroups?.groups || {};
                const combinations = this.settings.fileGroups?.combinations || {};
                const combo = combinations[rangeRef.name];
                if (combo && combo.groups) {
                    for (const groupName of combo.groups) {
                        const group = groups[groupName];
                        if (group && group.patterns) {
                            patternsArray = patternsArray.concat(group.patterns);
                        }
                    }
                    rangeType = "組合";
                    originalPatternsText = patternsArray.join('\n');
                } else {
                    new Notice(`組合「${rangeRef.name}」不存在`);
                    return false;
                }
            } else if (rangeRef.patternsText) {
                // 修改版或自定義：直接使用 patternsText
                originalPatternsText = rangeRef.patternsText;
                patternsArray = parsePatternsToRegexArray(originalPatternsText);
                if (rangeRef.type === "group") {
                    rangeType = "文件組";
                } else if (rangeRef.type === "combination") {
                    rangeType = "組合";
                } else {
                    rangeType = "自訂";
                }
            }
            
            if (originalPatternsText) {
                // 使用 DOM 直接判断编辑区是否已展开（不依赖闭包变量 isExpanded）
                const isActuallyExpanded = multiLineTextarea.style.display === 'block';
                if (!isActuallyExpanded) {
                    // 手动展开编辑区（不复制单行输入框的值）
                    singleLineInput.style.display = 'none';
                    multiLineTextarea.style.display = 'block';
                    if (autoResizeTextarea) autoResizeTextarea();
                    multiLineTextarea.focus();
                }
                multiLineTextarea.value = originalPatternsText;
                if (autoResizeTextarea) autoResizeTextarea();
                
                // 保存原始信息
                const originalPatterns = patternsArray.map(p => new RegExp(p));
                this.pendingRangeInfo = {
                    name: rangeRef.name,
                    type: rangeRef.type,
                    rangeType: rangeType,
                    originalPatterns: originalPatterns
                };
                
                // 設置自定義範圍按鈕的 📌 狀態
                if (setCustomButtonState) {
                    setCustomButtonState(rangeRef.name, rangeType, originalPatternsText);
                }
                
                // 更新高亮狀態
                if (updateButtonHighlight) updateButtonHighlight();
            }
        }
        else if (rangeRef.patternsText) {
            // 完全自定義範圍
            const patternsText = rangeRef.patternsText;
            
            // 使用 DOM 直接判断编辑区是否已展开（不依赖闭包变量 isExpanded）
            const isActuallyExpanded = multiLineTextarea.style.display === 'block';
            if (!isActuallyExpanded) {
                // 手动展开编辑区（不复制单行输入框的值）
                singleLineInput.style.display = 'none';
                multiLineTextarea.style.display = 'block';
                if (autoResizeTextarea) autoResizeTextarea();
                multiLineTextarea.focus();
            }
            multiLineTextarea.value = patternsText;
            if (autoResizeTextarea) autoResizeTextarea();
            
            // 清除 pendingRangeInfo（因為這是完全自定義，不是從組/組合來的）
            this.pendingRangeInfo = null;
            
            // 清除自定義範圍按鈕的 📌 狀態（因為這是全新的自定義內容）
            if (clearCustomButtonState) {
                clearCustomButtonState();
            }
            
            // 更新高亮狀態
            if (updateButtonHighlight) updateButtonHighlight();
        }
        
        // 聚焦到搜索輸入框
        searchTextInput.focus();
        searchTextInput.select();
        
        return true;
    }

    // 獲取歷史條目的顯示文本（公共方法）
    getHistoryDisplayText(item) {
        const searchPreview = item.searchText.length > 35 
            ? item.searchText.substring(0, 32) + "..." 
            : item.searchText;
        
        const rangeRef = item.rangeRef;
        let rangePreview = "";
        
        if (rangeRef.type === "default") {
            rangePreview = "預設";
        } else if (rangeRef.type === "group" && !rangeRef.patternsText) {
            rangePreview = `組：${rangeRef.name}`;
        } else if (rangeRef.type === "group" && rangeRef.patternsText) {
            rangePreview = `組：${rangeRef.name}（改）`;
        } else if (rangeRef.type === "combination" && !rangeRef.patternsText) {
            rangePreview = `組合：${rangeRef.name}`;
        } else if (rangeRef.type === "combination" && rangeRef.patternsText) {
            rangePreview = `組合：${rangeRef.name}（改）`;
        } else {
            rangePreview = "自訂";
        }
        
        return `${searchPreview} | ${rangePreview}`;
    }

    // ==================== 對話框函數 ====================

    async showSearchModeDialog(selectedText, previousFileName = '', prefillAsMultiLine = false, restoreRangeRef = null, initialBooleanQuery = null, initialDiacriticIgnore = null, initialHtmlTagIgnore = null) {
        const filePatterns = this.filePatterns;
        
        // 如果已經存在對話框，更新內容並聚焦，不創建新對話框
        if (this.currentModal && document.body.contains(this.currentModal)) {
            // 聚焦到現有對話框
            this.currentModal.focus();
            
            // 更新搜索輸入框（如果有選中文本）
            if (selectedText) {
                const searchInput = this.currentModal.querySelector('.search-text-input');
                if (searchInput) {
                    searchInput.value = selectedText;
                    searchInput.focus();
                    searchInput.select();
                }
            }
            
            // 返回一個永遠不 resolve 的 Promise，讓用戶繼續使用現有對話框
            // 這樣不會觸發後續的搜索邏輯
            return new Promise(() => {});
        }
        
        return new Promise((resolve) => {
            // 檢查是否有從外部傳入的 pendingRangeInfo（用於歷史重新搜索時恢復狀態）
            const initialPendingRange = this.pendingRangeInfo;
            if (initialPendingRange && initialPendingRange.name) {
                // 保存一份副本，稍後在設置編輯區後恢復狀態
                this._initialPendingRangeForRestore = { ...initialPendingRange };
            }
            
            // 檢查是否有從歷史傳入的 restoreRangeRef（用於歷史打開時恢復 📌 狀態）
            if (restoreRangeRef) {
                // 處理 default 類型（預設範圍）
                if (restoreRangeRef.type === 'default') {
                    // 預設範圍：清空編輯區內容，收起多行模式，清除自定義範圍狀態
                    this._restoreToDefaultRange = true;
                    // 清除待處理的範圍信息
                    this.pendingRangeInfo = null;
                    // 清除自定義範圍的臨時恢復標記
                    delete this._initialPendingRangeForRestore;
                    delete this._restorePatternsText;
                }
                // 處理 group 或 combination 類型
                else if (restoreRangeRef.type === 'group' || restoreRangeRef.type === 'combination') {
                    // 從 restoreRangeRef 構建恢復信息
                    const groups = this.settings.fileGroups?.groups || {};
                    const combinations = this.settings.fileGroups?.combinations || {};
                    let patternsArray = [];
                    let rangeType = "";
                    let originalPatternsText = "";
                    
                    if (restoreRangeRef.type === 'group') {
                        const group = groups[restoreRangeRef.name];
                        if (group && group.patterns) {
                            patternsArray = group.patterns;
                            rangeType = "文件組";
                            originalPatternsText = patternsArray.join('\n');
                        }
                    } else if (restoreRangeRef.type === 'combination') {
                        const combo = combinations[restoreRangeRef.name];
                        if (combo && combo.groups) {
                            for (const groupName of combo.groups) {
                                const group = groups[groupName];
                                if (group && group.patterns) {
                                    patternsArray = patternsArray.concat(group.patterns);
                                }
                            }
                            rangeType = "組合";
                            originalPatternsText = patternsArray.join('\n');
                        }
                    }
                    
                    if (patternsArray.length > 0) {
                        // 保存恢復信息
                        this._initialPendingRangeForRestore = {
                            name: restoreRangeRef.name,
                            type: restoreRangeRef.type,
                            rangeType: rangeType,
                            originalPatterns: patternsArray.map(p => new RegExp(p))
                        };
                        // 設置編輯區內容（稍後會在展開後使用）
                        this._restorePatternsText = originalPatternsText;
                    }
                }
            }
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: var(--background-primary);
                border-radius: 12px;
                padding: 24px;
                z-index: 10000;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                min-width: 500px;
                max-width: 90vw;
                border: 1px solid var(--background-modifier-border);
            `;
            
            // 保存當前對話框引用
            this.currentModal = modal;

            const titleContainer = document.createElement('div');
            titleContainer.style.cssText = `position: relative; text-align: center; margin-bottom: 20px;`;
            
            const title = document.createElement('div');
            title.textContent = '📖 選擇搜索模式';
            title.style.cssText = `font-size: 18px; font-weight: 600; display: inline-block;`;
            
            const settingsBtn = document.createElement('button');
            settingsBtn.innerHTML = '⚙️';
            settingsBtn.style.cssText = `
                position: absolute;
                right: 0;
                top: 50%;
                transform: translateY(-50%);
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 18px;
                padding: 4px 8px;
                border-radius: 6px;
                color: var(--text-muted);
                transition: all 0.2s;
            `;
            settingsBtn.title = '打開插件設置';
            settingsBtn.onmouseenter = () => {
                settingsBtn.style.backgroundColor = 'var(--background-modifier-hover)';
                settingsBtn.style.color = 'var(--text-normal)';
            };
            settingsBtn.onmouseleave = () => {
                settingsBtn.style.backgroundColor = 'transparent';
                settingsBtn.style.color = 'var(--text-muted)';
            };
            settingsBtn.onclick = () => {
                modal.remove();
                // @ts-ignore
                this.app.setting.open();
                // @ts-ignore
                this.app.setting.openTabById(this.manifest.id);
            };
            
            titleContainer.appendChild(title);
            titleContainer.appendChild(settingsBtn);
            modal.appendChild(titleContainer);

            const searchTextLabel = document.createElement('div');
            searchTextLabel.textContent = '📝 搜索內容(可修改/已存至剪切板)：';
            searchTextLabel.style.cssText = `font-size: 13px; margin-bottom: 6px;`;
            modal.appendChild(searchTextLabel);
            
            const searchTextInput = document.createElement('input');
            searchTextInput.type = 'text';
            searchTextInput.value = selectedText;
            searchTextInput.className = 'search-text-input';  // 添加這一行
            searchTextInput.style.cssText = `width: 100%; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--background-modifier-border); border-radius: 6px;`;
            modal.appendChild(searchTextInput);
            
            // ========== 歷史下拉面板 ==========
            let historyDropdown = null;
            let currentHighlightIndex = -1;
            
            // 關閉下拉面板的函數
            const closeHistoryDropdown = () => {
                if (historyDropdown) {
                    historyDropdown.remove();
                    historyDropdown = null;
                    currentHighlightIndex = -1;
                }
            };
            
            // 創建歷史下拉面板
            const createHistoryDropdown = () => {
                const history = this.settings.searchHistory;
                if (!history || !history.items || history.items.length === 0) {
                    return null;
                }
                
                const dropdown = document.createElement('div');
                dropdown.className = 'custom-search-history-dropdown';
                dropdown.style.cssText = `
                    position: absolute;
                    z-index: 10001;
                    background: rgba(var(--background-primary-rgb), 0.95);
                    backdrop-filter: blur(8px);
                    border: 1px solid var(--background-modifier-border);
                    border-radius: 8px;
                    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
                    max-height: 200px;
                    overflow-y: auto;
                    width: ${searchTextInput.offsetWidth}px;
                    min-width: 300px;
                `;
                
                // 計算位置
                const rect = searchTextInput.getBoundingClientRect();
                const modalRect = modal.getBoundingClientRect();
                dropdown.style.top = `${rect.bottom + 4}px`;
                dropdown.style.left = `${rect.left}px`;
                dropdown.style.width = `${rect.width}px`;
                
                // 渲染歷史列表項
                const items = history.items;
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    const row = dropdown.createEl('div', {
                        attr: {
                            style: `
                                display: flex;
                                align-items: center;
                                justify-content: space-between;
                                padding: 8px 12px;
                                cursor: pointer;
                                border-bottom: 1px solid var(--background-modifier-border);
                                transition: background 0.15s;
                            `
                        }
                    });
                    
                    // 獲取顯示文本
                    const displayText = this.getHistoryDisplayText(item);
                    const textSpan = row.createEl('span', {
                        text: displayText,
                        attr: {
                            style: `
                                flex: 1;
                                font-size: 12px;
                                font-family: monospace;
                                overflow: hidden;
                                text-overflow: ellipsis;
                                white-space: nowrap;
                                color: var(--text-normal);
                            `,
                            title: displayText
                        }
                    });
                    
                    // 鼠標懸停效果
                    row.onmouseenter = () => {
                        if (currentHighlightIndex !== i) {
                            if (dropdown.querySelector('.dropdown-highlight')) {
                                const prev = dropdown.querySelector('.dropdown-highlight');
                                prev.style.backgroundColor = '';
                                prev.classList.remove('dropdown-highlight');
                            }
                            row.style.backgroundColor = 'var(--background-modifier-hover)';
                            currentHighlightIndex = i;
                        }
                    };
                    
                    row.onmouseleave = () => {
                        if (currentHighlightIndex === i) {
                            row.style.backgroundColor = '';
                            currentHighlightIndex = -1;
                        }
                    };
                    
                    // 點擊選擇歷史項
                    row.onclick = async () => {
                        const selectedItem = items[i];
                        if (selectedItem) {
                            closeHistoryDropdown();
                            // 直接更新當前對話框，不重建
                            await this.updateCurrentDialogWithHistory(selectedItem, {
                                searchTextInput,
                                booleanQueryCheckbox,
                                htmlTagIgnoreCheckbox,
                                diacriticIgnoreCheckbox,
                                singleLineInput,
                                multiLineTextarea,
                                isExpanded,
                                expandToMultiLine,
                                autoResizeTextarea,
                                clearCustomButtonState,
                                setCustomButtonState,
                                updateButtonHighlight,
                                getFileNamePatterns,
                                customButtonState,
                                pendingRangeInfo: this.pendingRangeInfo
                            });
                        }
                    };
                    
                    dropdown.appendChild(row);
                }
                
                return dropdown;
            };

            // 顯示歷史下拉
            const showHistoryDropdown = () => {
                // 如果已經存在下拉面板，不重複創建
                if (historyDropdown) return;
                if (searchTextInput.value.trim() !== '') {
                    return; // 輸入框有內容時不顯示下拉
                }
                historyDropdown = createHistoryDropdown();
                if (historyDropdown) {
                    document.body.appendChild(historyDropdown);
                    // 添加鍵盤導航支持
                    setupDropdownKeyboard();
                }
            };

            // 鍵盤導航
            const setupDropdownKeyboard = () => {
                if (!historyDropdown) return;
                
                const items = historyDropdown.querySelectorAll('div[style*="cursor: pointer"]');
                if (items.length === 0) return;
                
                const updateHighlight = (index) => {
                    items.forEach((item, i) => {
                        if (i === index) {
                            item.style.backgroundColor = 'var(--background-modifier-hover)';
                            currentHighlightIndex = index;
                            // 滾動到可視區域
                            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        } else {
                            item.style.backgroundColor = '';
                        }
                    });
                };
                
                const keydownHandler = async (e) => {
                    if (!historyDropdown) {
                        document.removeEventListener('keydown', keydownHandler);
                        return;
                    }
                    
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        if (currentHighlightIndex < items.length - 1) {
                            updateHighlight(currentHighlightIndex + 1);
                        } else if (currentHighlightIndex === -1 && items.length > 0) {
                            updateHighlight(0);
                        }
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        if (currentHighlightIndex > 0) {
                            updateHighlight(currentHighlightIndex - 1);
                        } else if (currentHighlightIndex === -1 && items.length > 0) {
                            updateHighlight(items.length - 1);
                        }
                    } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (currentHighlightIndex >= 0 && currentHighlightIndex < items.length) {
                            const selectedItem = history.items[currentHighlightIndex];
                            if (selectedItem) {
                                closeHistoryDropdown();
                                document.removeEventListener('keydown', keydownHandler);
                                // 直接更新當前對話框，不重建
                                await this.updateCurrentDialogWithHistory(selectedItem, {
                                    searchTextInput,
                                    booleanQueryCheckbox,
                                    htmlTagIgnoreCheckbox,
                                    diacriticIgnoreCheckbox,
                                    singleLineInput,
                                    multiLineTextarea,
                                    isExpanded,
                                    expandToMultiLine,
                                    autoResizeTextarea,
                                    clearCustomButtonState,
                                    setCustomButtonState,
                                    updateButtonHighlight,
                                    getFileNamePatterns,
                                    customButtonState,
                                    pendingRangeInfo: this.pendingRangeInfo
                                });
                            }
                        }
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        closeHistoryDropdown();
                        document.removeEventListener('keydown', keydownHandler);
                        searchTextInput.focus();
                    } else {
                        // 輸入字符時關閉下拉
                        closeHistoryDropdown();
                        document.removeEventListener('keydown', keydownHandler);
                    }
                };
                
                document.addEventListener('keydown', keydownHandler);
                // 保存處理器以便清理
                historyDropdown._keydownHandler = keydownHandler;
            };
            
            // 聚焦時：如果輸入框為空，顯示歷史下拉
            searchTextInput.addEventListener('focus', () => {
                if (searchTextInput.value.trim() === '') {
                    showHistoryDropdown();
                }
                // 添加外部點擊關閉監聽
                document.addEventListener('mousedown', closeOnClickOutside);
            });
            
            // 點擊輸入框時：如果輸入框為空，顯示歷史下拉（處理已聚焦但下拉被關閉後重新點擊的情況）
            searchTextInput.addEventListener('click', (e) => {
                e.stopPropagation();
                if (searchTextInput.value.trim() === '') {
                    showHistoryDropdown();
                }
            });
            
            // 輸入時：清空時顯示下拉，有內容時關閉下拉
            searchTextInput.addEventListener('input', () => {
                if (searchTextInput.value.trim() === '') {
                    showHistoryDropdown();
                } else {
                    closeHistoryDropdown();
                }
            });
            
            // 失去焦點時：延遲關閉下拉，給用戶時間點擊下拉項
            searchTextInput.addEventListener('blur', () => {
                setTimeout(() => {
                    if (historyDropdown) {
                        // 檢查鼠標是否在下拉面板上
                        const hoveredElement = document.querySelector(':hover');
                        if (!historyDropdown.contains(hoveredElement)) {
                            closeHistoryDropdown();
                        }
                    }
                    document.removeEventListener('mousedown', closeOnClickOutside);
                }, 200);
            });
            
            // 點擊其他地方關閉下拉（備用方案）
            const closeOnClickOutside = (e) => {
                if (historyDropdown && !historyDropdown.contains(e.target) && e.target !== searchTextInput) {
                    closeHistoryDropdown();
                    document.removeEventListener('mousedown', closeOnClickOutside);
                }
            };

            // 對話框關閉時清理下拉
            const originalModalRemove = modal.remove.bind(modal);
            modal.remove = () => {
                closeHistoryDropdown();
                originalModalRemove();
                // 清除全局對話框引用
                if (this.currentModal === modal) {
                    this.currentModal = null;
                }
                // 清理臨時變量
                delete this._restoreToDefaultRange;
                delete this._restorePatternsText;
                delete this._restoreBooleanQuery;
                delete this._restoreHtmlTagIgnore;
                delete this._restoreDiacriticIgnore;
                delete this._initialPendingRangeForRestore;
            };

            // 布爾查詢開關
            const booleanQueryRow = document.createElement('div');
            booleanQueryRow.style.cssText = `display: flex; align-items: center; gap: 1px; margin-bottom: 16px;`;
            const booleanQueryCheckbox = document.createElement('input');
            booleanQueryCheckbox.type = 'checkbox';
            booleanQueryCheckbox.id = 'boolean-query-checkbox';
            booleanQueryCheckbox.checked = initialBooleanQuery !== null ? initialBooleanQuery : this.settings.enableBooleanQuery;
            booleanQueryCheckbox.style.cssText = `width: 10px; height: 10px; cursor: pointer; margin-bottom: 3px;`;
            const booleanQueryLabel = document.createElement('label');
            booleanQueryLabel.htmlFor = 'boolean-query-checkbox';
            booleanQueryLabel.textContent = '布爾查詢';
            booleanQueryLabel.style.cssText = `font-size: 12px; cursor: pointer;`;
            booleanQueryLabel.title = '布爾查詢（與無視標籤、忽略變音、正則模式互斥）';

            // 無視標籤開關
            const htmlTagIgnoreCheckbox = document.createElement('input');
            htmlTagIgnoreCheckbox.type = 'checkbox';
            htmlTagIgnoreCheckbox.id = 'html-tag-ignore-checkbox';
            htmlTagIgnoreCheckbox.checked = initialHtmlTagIgnore !== null ? initialHtmlTagIgnore : this.settings.enableHtmlTagIgnore;
            htmlTagIgnoreCheckbox.style.cssText = `width: 10px; height: 10px; cursor: pointer; margin-left: 12px; margin-bottom: 3px;`;
            const htmlTagIgnoreLabel = document.createElement('label');
            htmlTagIgnoreLabel.htmlFor = 'html-tag-ignore-checkbox';
            htmlTagIgnoreLabel.textContent = '無視標籤';
            htmlTagIgnoreLabel.style.cssText = `font-size: 12px; cursor: pointer;`;
            htmlTagIgnoreLabel.title = '無視標籤（與布爾查詢、正則模式互斥）';

            // 忽略變音開關
            const diacriticIgnoreCheckbox = document.createElement('input');
            diacriticIgnoreCheckbox.type = 'checkbox';
            diacriticIgnoreCheckbox.id = 'diacritic-ignore-checkbox';
            diacriticIgnoreCheckbox.checked = initialDiacriticIgnore !== null ? initialDiacriticIgnore : this.settings.enableDiacriticIgnore;
            // 從歷史恢復布爾模式、無視標籤開關和忽略變音開關（優先級高於 initialBooleanQuery）
            if (this._restoreBooleanQuery !== undefined) {
                booleanQueryCheckbox.checked = this._restoreBooleanQuery;
                delete this._restoreBooleanQuery;
            }
            if (this._restoreHtmlTagIgnore !== undefined) {
                htmlTagIgnoreCheckbox.checked = this._restoreHtmlTagIgnore;
                delete this._restoreHtmlTagIgnore;
            }
            if (this._restoreDiacriticIgnore !== undefined) {
                diacriticIgnoreCheckbox.checked = this._restoreDiacriticIgnore;
                delete this._restoreDiacriticIgnore;
            }
            diacriticIgnoreCheckbox.style.cssText = `width: 10px; height: 10px; cursor: pointer; margin-left: 12px; margin-bottom: 3px;`;
            const diacriticIgnoreLabel = document.createElement('label');
            diacriticIgnoreLabel.htmlFor = 'diacritic-ignore-checkbox';
            diacriticIgnoreLabel.textContent = '忽略變音';
            diacriticIgnoreLabel.style.cssText = `font-size: 12px; cursor: pointer;`;
            diacriticIgnoreLabel.title = '忽略變音（與布爾查詢互斥）';

            // 完整提示說明
            const booleanQueryHint = document.createElement('span');
            booleanQueryHint.textContent = '❔';
            booleanQueryHint.style.cssText = `font-size: 11px; color: var(--text-faint); cursor: help; margin-left: 4px;`;
            booleanQueryHint.title = '💡 ①布爾模式：空格 & = AND;ᅠ | = OR;ᅠ ! = NOT;ᅠ ( ) = 分組\n\n💡 ②無視標籤：忽略 HTML 標籤、MD語法及標點符號\n\n💡 ③忽略變音：忽略七組變音符號（a/ā/â等）\n\n📖 ④正則模式：標識 * + ? $ { } \\ [ ]\n\n🚫 注意：①②④ 三者互斥，①③互斥';

            // 互斥邏輯：布爾查詢 ↔ 無視標籤|忽略變音 
            booleanQueryCheckbox.addEventListener('change', () => {
                if (booleanQueryCheckbox.checked) {
                    // 關閉「無視標籤」
                    if (htmlTagIgnoreCheckbox.checked) {
                        htmlTagIgnoreCheckbox.checked = false;
                    }
                    // 關閉「忽略變音」
                    if (diacriticIgnoreCheckbox.checked) {
                        diacriticIgnoreCheckbox.checked = false;
                    }
                    // 禁用無視標籤和忽略變音
                    htmlTagIgnoreCheckbox.disabled = true;
                    htmlTagIgnoreLabel.style.opacity = '0.5';
                    diacriticIgnoreCheckbox.disabled = true;
                    diacriticIgnoreLabel.style.opacity = '0.5';
                } else {
                    // 恢復無視標籤的可用狀態（需要檢查正則模式）
                    const searchValue = searchTextInput.value;
                    const isRegexMode = isRegexPattern(searchValue);
                    if (!isRegexMode) {
                        htmlTagIgnoreCheckbox.disabled = false;
                        htmlTagIgnoreLabel.style.opacity = '1';
                        diacriticIgnoreCheckbox.disabled = false;
                        diacriticIgnoreLabel.style.opacity = '1';
                    }
                }
            });

            // 互斥：忽略變音 ↔ 布爾查詢 
            diacriticIgnoreCheckbox.addEventListener('change', () => {
                if (diacriticIgnoreCheckbox.checked && booleanQueryCheckbox.checked) {
                    // 關閉「布爾查詢」
                    booleanQueryCheckbox.checked = false;
                }
                if (diacriticIgnoreCheckbox.checked) {
                    booleanQueryCheckbox.disabled = true;
                    booleanQueryLabel.style.opacity = '0.5';
                } else {
                    // 恢復布爾查詢的可用狀態（需要檢查正則模式和無視標籤的狀態）
                    const searchValue = searchTextInput.value;
                    const isRegexMode = isRegexPattern(searchValue);
                    const isTagIgnoreOn = htmlTagIgnoreCheckbox.checked;
                    if (!isRegexMode && !isTagIgnoreOn) {
                        booleanQueryCheckbox.disabled = false;
                        booleanQueryLabel.style.opacity = '1';
                    }
                }
            });

            htmlTagIgnoreCheckbox.addEventListener('change', () => {
                if (htmlTagIgnoreCheckbox.checked && booleanQueryCheckbox.checked) {
                    // 關閉「布爾查詢」
                    booleanQueryCheckbox.checked = false;
                }
                if (htmlTagIgnoreCheckbox.checked) {
                    booleanQueryCheckbox.disabled = true;
                    booleanQueryLabel.style.opacity = '0.5';
                } else {
                    // 恢復布爾查詢的可用狀態（需要檢查正則模式和忽略變音的狀態）
                    const searchValue = searchTextInput.value;
                    const isRegexMode = isRegexPattern(searchValue);
                    const isDiacriticIgnoreOn = diacriticIgnoreCheckbox.checked;
                    if (!isRegexMode && !isDiacriticIgnoreOn) {
                        booleanQueryCheckbox.disabled = false;
                        booleanQueryLabel.style.opacity = '1';
                    }
                }
            });

            // 監聽搜索輸入框的正則模式檢測（普通文本分支加入忽略變音判斷）
            const checkModeConflicts = () => {
                const searchValue = searchTextInput.value;
                const isRegexMode = isRegexPattern(searchValue);
                // 布爾模式與正則互斥
                if (isRegexMode && booleanQueryCheckbox.checked) {
                    // 關閉「布爾查詢」
                    booleanQueryCheckbox.checked = false;
                    // 觸發布爾模式的 change 事件，以便更新狀態
                    booleanQueryCheckbox.dispatchEvent(new Event('change'));
                }
                // 正則模式與無視標籤互斥
                if (isRegexMode && htmlTagIgnoreCheckbox.checked) {
                    // 關閉「無視標籤」
                    htmlTagIgnoreCheckbox.checked = false;
                }

                if (isRegexMode) {
                    htmlTagIgnoreCheckbox.disabled = true;
                    htmlTagIgnoreLabel.style.opacity = '0.5';
                    booleanQueryCheckbox.disabled = true;
                    booleanQueryLabel.style.opacity = '0.5';
                    // 忽略變音可用（如果之前被布爾查詢禁用，現在恢復）
                    diacriticIgnoreCheckbox.disabled = false;
                    diacriticIgnoreLabel.style.opacity = '1';
                } else {  // 普通文本下
                    const isBooleanOn = booleanQueryCheckbox.checked;
                    const isTagIgnoreOn = htmlTagIgnoreCheckbox.checked;
                    const isDiacriticIgnoreOn = diacriticIgnoreCheckbox.checked;

                    // 布爾查詢的禁用状态：选中了無視標籤 或 选中了忽略變音
                    booleanQueryCheckbox.disabled = isTagIgnoreOn || isDiacriticIgnoreOn;
                    booleanQueryLabel.style.opacity = (isTagIgnoreOn || isDiacriticIgnoreOn) ? '0.5' : '1';

                    // 無視標籤的禁用状态：选中了布爾查詢
                    htmlTagIgnoreCheckbox.disabled = isBooleanOn;
                    htmlTagIgnoreLabel.style.opacity = isBooleanOn ? '0.5' : '1';
                    
                    // 忽略變音的禁用状态：选中了布爾查詢
                    diacriticIgnoreCheckbox.disabled = isBooleanOn;
                    diacriticIgnoreLabel.style.opacity = isBooleanOn ? '0.5' : '1';
                }
            };

            searchTextInput.addEventListener('input', checkModeConflicts);

            // 初始化時同步狀態，確保互斥規則生效（處理歷史恢復時可能同時開啟的情況）
            const initSync = () => {
                // 如果布爾查詢和忽略變音同時開啟，關閉忽略變音（優先保留布爾查詢）
                if (booleanQueryCheckbox.checked && diacriticIgnoreCheckbox.checked) {
                    diacriticIgnoreCheckbox.checked = false;
                    diacriticIgnoreCheckbox.dispatchEvent(new Event('change'));
                }
                // 如果布爾查詢和無視標籤同時開啟，關閉無視標籤
                if (booleanQueryCheckbox.checked && htmlTagIgnoreCheckbox.checked) {
                    htmlTagIgnoreCheckbox.checked = false;
                    htmlTagIgnoreCheckbox.dispatchEvent(new Event('change'));
                }
                // 觸發一次 checkModeConflicts 確保 UI 狀態正確
                checkModeConflicts();
            };

            setTimeout(initSync, 100);

            booleanQueryRow.appendChild(booleanQueryCheckbox);
            booleanQueryRow.appendChild(booleanQueryLabel);
            booleanQueryRow.appendChild(htmlTagIgnoreCheckbox);
            booleanQueryRow.appendChild(htmlTagIgnoreLabel);
            booleanQueryRow.appendChild(diacriticIgnoreCheckbox);
            booleanQueryRow.appendChild(diacriticIgnoreLabel);
            booleanQueryRow.appendChild(booleanQueryHint);
            modal.appendChild(booleanQueryRow);

            // ========== 公共函數：應用組/組合到自定義範圍 ==========
            const applyGroupOrCombinationToCustomRange = (rangeName, rangeType, patternsText, originalPatterns) => {
                if (!rangeName || !rangeType || !patternsText) return false;
                
                // 展開編輯區並填充內容（expandToMultiLine 內部已做 DOM 判斷）
                expandToMultiLine();
                multiLineTextarea.value = patternsText;
                autoResizeTextarea();
                
                // 保存原始信息，等用戶提交時判斷
                this.pendingRangeInfo = {
                    name: rangeName,
                    type: rangeType === '文件組' ? 'group' : 'combination',
                    rangeType: rangeType,
                    originalPatterns: originalPatterns
                };
                
                // 設置自定義範圍按鈕的 📌 狀態
                setCustomButtonState(rangeName, rangeType, patternsText);
                
                // 更新高亮狀態（自定義範圍有內容）
                updateButtonHighlight();
                
                new Notice(`✅ 已載入「${rangeName}」(${rangeType})，可繼續編輯`);
                return true;
            };

            const fileNameHeader = document.createElement('div');
            fileNameHeader.style.cssText = `display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; margin-top: 0px;`;
            
            const fileNameLabel = document.createElement('div');
            fileNameLabel.textContent = '📖 文件名匹配(每行一個，支持正則)：';
            fileNameLabel.style.cssText = `font-size: 13px; font-weight: 500;`;
            fileNameHeader.appendChild(fileNameLabel);
            
            // 右側容器
            const headerBtnContainer = document.createElement('div');
            headerBtnContainer.style.cssText = `display: flex; gap: 8px;`;
            
            const hintBtn = document.createElement('button');
            hintBtn.textContent = '📋 查看示例';
            hintBtn.style.cssText = `background: transparent; border: none; color: var(--text-accent); cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 4px;`;

            // 選已有組
            const groupSelect = document.createElement('select');
            groupSelect.style.cssText = `background: transparent; border: 1px solid var(--background-modifier-border); border-radius: 4px; font-size: 11px; padding: 2px 8px; color: var(--text-muted); cursor: pointer;`;
            groupSelect.title = '從已有的文件組或組合中選擇';

            // 更新下拉框內容的函數
            const updateGroupSelect = () => {
                groupSelect.innerHTML = '<option value="">-- 選已有組 --</option>';
                const storageData = this.settings.fileGroups || { groups: {}, combinations: {} };
                const groups = storageData.groups || {};
                const combinations = storageData.combinations || {};
                
                if (Object.keys(groups).length > 0) {
                    const groupOptgroup = document.createElement('optgroup');
                    groupOptgroup.label = '📚 文件組';
                    for (const groupName of Object.keys(groups)) {
                        const option = document.createElement('option');
                        option.value = `group:${groupName}`;
                        option.textContent = groupName;
                        groupOptgroup.appendChild(option);
                    }
                    groupSelect.appendChild(groupOptgroup);
                }
                
                if (Object.keys(combinations).length > 0) {
                    const comboOptgroup = document.createElement('optgroup');
                    comboOptgroup.label = '🔗 組合';
                    for (const comboName of Object.keys(combinations)) {
                        const option = document.createElement('option');
                        option.value = `combination:${comboName}`;
                        option.textContent = comboName;
                        comboOptgroup.appendChild(option);
                    }
                    groupSelect.appendChild(comboOptgroup);
                }
                
                if (Object.keys(groups).length === 0 && Object.keys(combinations).length === 0) {
                    const option = document.createElement('option');
                    option.value = "";
                    option.textContent = '暫無文件組/組合';
                    option.disabled = true;
                    groupSelect.appendChild(option);
                }
            };
            
            // 輔助函數：從組/組合獲取 patternsText 和 originalPatterns
            const getGroupPatternsData = (name, type) => {
                const storageData = this.settings.fileGroups || { groups: {}, combinations: {} };
                const groups = storageData.groups || {};
                const combinations = storageData.combinations || {};
                let patternsArray = [];
                let rangeTypeForDisplay = "";
                
                if (type === 'group') {
                    const group = groups[name];
                    if (!group || !group.patterns || group.patterns.length === 0) {
                        new Notice(`文件組「${name}」為空`);
                        return null;
                    }
                    patternsArray = group.patterns;
                    rangeTypeForDisplay = "文件組";
                } else if (type === 'combination') {
                    const combo = combinations[name];
                    if (!combo || !combo.groups || combo.groups.length === 0) {
                        new Notice(`組合「${name}」為空`);
                        return null;
                    }
                    for (const groupName of combo.groups) {
                        const group = groups[groupName];
                        if (group && group.patterns) {
                            patternsArray = patternsArray.concat(group.patterns);
                        }
                    }
                    if (patternsArray.length === 0) {
                        new Notice(`組合「${name}」中的文件組都為空`);
                        return null;
                    }
                    rangeTypeForDisplay = "組合";
                } else {
                    return null;
                }
                
                return {
                    patternsText: patternsArray.join('\n'),
                    rangeType: rangeTypeForDisplay,
                    originalPatterns: patternsArray.map(p => new RegExp(p))
                };
            };
            
            // 下拉框選擇變化
            groupSelect.onchange = (e) => {
                const value = groupSelect.value;
                if (!value) return;
                
                const [type, name] = value.split(':');
                if (name) {
                    const data = getGroupPatternsData(name, type);
                    if (data) {
                        applyGroupOrCombinationToCustomRange(name, data.rangeType, data.patternsText, data.originalPatterns);
                    }
                }
                // 重置為默認提示選項
                groupSelect.value = '';
            };
            
            // 初始化內容
            updateGroupSelect();
            
            headerBtnContainer.appendChild(hintBtn);
            headerBtnContainer.appendChild(groupSelect);
            fileNameHeader.appendChild(headerBtnContainer);
            modal.appendChild(fileNameHeader);

            // 查看示例 - 點擊觸發
            let patternTooltip = null;
            
            const showPatternTooltip = () => {
                // 如果已經存在，先移除
                if (patternTooltip) {
                    patternTooltip.remove();
                    patternTooltip = null;
                    return;
                }
                
                patternTooltip = document.createElement('div');
                patternTooltip.style.cssText = `
                    position: fixed;
                    background: var(--background-primary);
                    border: 1px solid var(--background-modifier-border);
                    border-radius: 8px;
                    padding: 12px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                    z-index: 10001;
                    max-width: 420px;
                    font-size: 12px;
                `;
                
                patternTooltip.innerHTML = `
                    <div style="margin-bottom: 8px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;">
                        <span>📋 文件名模式示例</span>
                        <span style="font-size: 10px; color: var(--text-faint);">(可直接選中文字複製)</span>
                    </div>
                    <pre style="margin: 0; padding: 8px; background: var(--background-secondary); border-radius: 6px; font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; user-select: text; max-height: 100px; overflow-y: auto;">
# 純文件名正則
^(集異門|法蘊|品類|識身)足論\\.md
(婆沙|正理|本義抄)\\d+-\\d+\\.md
(心論雜心|AKBh)\\d+\\.md
^(甘露味論|入阿毘達磨論)\\.md
俱舍論記疏\\d+\\.md
俱舍所依阿含\\.md
陰持入經註?.md
成實論\\.md

# 路徑正則
^agama\\/[^\\/]+\\.md
^kosa\\/ju\\/
^kosa\\/ju\\/俱舍.+\\.md

# 藏經編號
T22n1428_四分律\\d+\\.md
T30n1579_瑜伽師地論\\d+\\.md
T25n1509_大智度論\\d+\\.md
T44n1851_大乘義章\\d+\\.md

# 排除規則（以 ! 開頭）
!.+疏22\\.md
!^vibhasa\\/others\\/
!.*甘露味.*\\.md</pre>
    `;
                
                document.body.appendChild(patternTooltip);
                const rect = hintBtn.getBoundingClientRect();
                patternTooltip.style.top = `${rect.bottom + 5}px`;
                patternTooltip.style.left = `${rect.right - 200}px`;
            };
            
            // 點擊關閉彈窗（點擊其他地方）
            const closePatternTooltipOnClickOutside = (e) => {
                if (patternTooltip && !hintBtn.contains(e.target) && !patternTooltip.contains(e.target)) {
                    patternTooltip.remove();
                    patternTooltip = null;
                }
            };
            
            // 點擊按鈕切換彈窗
            hintBtn.onclick = (e) => {
                e.stopPropagation();
                showPatternTooltip();
            };
            
            // 監聽點擊關閉
            document.addEventListener('click', closePatternTooltipOnClickOutside);
            
            modal.appendChild(fileNameHeader);

            const fileNameInputContainer = document.createElement('div');
            fileNameInputContainer.style.cssText = `margin-bottom: 20px;`;
            
            const singleLineInput = document.createElement('input');
            singleLineInput.type = 'text';
            singleLineInput.value = previousFileName || '';
            singleLineInput.placeholder = '文件名編輯（支持正則，每行一個），默認預定範圍';
            singleLineInput.style.cssText = `width: 100%; padding: 8px 10px; border: 1px solid var(--background-modifier-border); border-radius: 6px;`;
            
            const multiLineTextarea = document.createElement('textarea');
            multiLineTextarea.value = previousFileName || '';
            multiLineTextarea.style.cssText = `width: 100%; padding: 8px 10px; border: 1px solid var(--background-modifier-border); border-radius: 6px; font-family: monospace; resize: none; overflow-y: hidden; display: none; min-height: 38px;`;
            
            fileNameInputContainer.appendChild(singleLineInput);
            fileNameInputContainer.appendChild(multiLineTextarea);
            modal.appendChild(fileNameInputContainer);

            // 自定義範圍按鈕狀態管理
            let customButtonState = {
                active: false,      // 是否處於 📌 狀態
                rangeName: "",      // 應用的組/組合名稱
                rangeType: "",      // "文件組" 或 "組合"
                originalPatternsRaw: "",  // 原始模式文本（用於比較）
                isModified: false   // 是否已被修改
            };

            let isExpanded = false;
            const autoResizeTextarea = () => {
                multiLineTextarea.style.height = 'auto';
                multiLineTextarea.style.height = Math.min(multiLineTextarea.scrollHeight, 300) + 'px';
            };

            const expandToMultiLine = () => {
                // 從 DOM 實時判斷是否已展開
                if (multiLineTextarea.style.display === 'block') return;
                isExpanded = true;
                multiLineTextarea.value = singleLineInput.value;
                singleLineInput.style.display = 'none';
                multiLineTextarea.style.display = 'block';
                autoResizeTextarea();
                multiLineTextarea.focus();
                const len = multiLineTextarea.value.length;
                multiLineTextarea.setSelectionRange(len, len);
            };

            // 如果是多行模式（來自重新搜索的自定義範圍），直接展開並顯示多行
            if (prefillAsMultiLine && previousFileName && previousFileName.includes('\n')) {
                expandToMultiLine();
                multiLineTextarea.value = previousFileName;
                // 需要等待 DOM 更新後再調整高度，並可能多次調整以確保正確
                setTimeout(() => {
                    autoResizeTextarea();
                    // 再次調整，確保內容完全顯示
                    setTimeout(() => autoResizeTextarea(), 50);
                }, 0);
            } 
            // 如果是從歷史恢復（有 _restorePatternsText），直接展開並顯示恢復的內容
            else if (this._restorePatternsText) {
                expandToMultiLine();
                multiLineTextarea.value = this._restorePatternsText;
                setTimeout(() => {
                    autoResizeTextarea();
                    setTimeout(() => autoResizeTextarea(), 50);
                }, 0);
                // 清除臨時存儲
                delete this._restorePatternsText;
            }
            // 如果是從歷史恢復預設範圍（需要清空編輯區並收起）
            else if (this._restoreToDefaultRange) {
                // 清空編輯區
                singleLineInput.value = '';
                multiLineTextarea.value = '';
                // 從 DOM 實時判斷是否需要收起
                const isActuallyExpanded = multiLineTextarea.style.display === 'block';
                if (isActuallyExpanded) {
                    isExpanded = false;
                    multiLineTextarea.style.display = 'none';
                    singleLineInput.style.display = 'block';
                }
                // 清除預設範圍恢復標記
                delete this._restoreToDefaultRange;
            }
            else {
                singleLineInput.addEventListener('focus', expandToMultiLine);
            }

            // 修改後：從 DOM 實時獲取展開狀態
            const updateButtonHighlight = () => {
                // 從 DOM 實時獲取當前編輯區是否展開，而不是依賴閉包變量
                const isActuallyExpanded = multiLineTextarea.style.display === 'block';
                const hasContent = isActuallyExpanded 
                    ? multiLineTextarea.value.trim() 
                    : singleLineInput.value.trim();
                
                if (hasContent) {
                    // 編輯區有內容 → 自定義範圍高亮
                    customLeft.style.borderColor = 'var(--interactive-accent)';
                    customRight.style.borderColor = 'var(--interactive-accent)';
                    presetLeft.style.borderColor = 'var(--background-modifier-border)';
                    presetRight.style.borderColor = 'var(--background-modifier-border)';
                } else {
                    // 編輯區無內容 → 預定範圍高亮
                    customLeft.style.borderColor = 'var(--background-modifier-border)';
                    customRight.style.borderColor = 'var(--background-modifier-border)';
                    presetLeft.style.borderColor = 'var(--interactive-accent)';
                    presetRight.style.borderColor = 'var(--interactive-accent)';
                }
            };

            // 監聽輸入框變化
            singleLineInput.addEventListener('input', updateButtonHighlight);
            multiLineTextarea.addEventListener('input', updateButtonHighlight);
            
            // 延遲初始化高亮狀態，確保 DOM 已準備好
            setTimeout(() => {
                updateButtonHighlight();
            }, 0);

            // 如果是從歷史重新搜索（有初始的 pendingRangeInfo），恢復 📌 狀態
            // 注意：需要等待編輯區完全展開後再設置，因為 multiLineTextarea 可能還在隱藏狀態
            if (this._initialPendingRangeForRestore) {
                const restoreInfo = this._initialPendingRangeForRestore;
                // 保存需要恢復的數據
                const restoreName = restoreInfo.name;
                const restoreType = restoreInfo.rangeType;
                
                // 延遲足夠的時間，確保編輯區已經展開並有正確的值
                // 使用遞迴重試機制，確保 setCustomButtonState 函數已定義且編輯區已就緒
                const tryRestoreState = (attempts = 0) => {
                    // 檢查編輯區是否有內容且已展開
                    const textareaHasValue = multiLineTextarea.value && multiLineTextarea.value.trim();
                    const isTextareaVisible = multiLineTextarea.style.display !== 'none';
                    
                    if (typeof setCustomButtonState !== 'undefined' && textareaHasValue && isTextareaVisible) {
                        // 一切就緒，設置按鈕狀態
                        setCustomButtonState(restoreName, restoreType, multiLineTextarea.value);
                        // 清除臨時標記
                        delete this._initialPendingRangeForRestore;
                    } else if (attempts < 10) {
                        // 還沒準備好，100ms 後重試
                        setTimeout(() => tryRestoreState(attempts + 1), 100);
                    } else {
                        // 超時後放棄，但清除標記避免重複嘗試
                        delete this._initialPendingRangeForRestore;
                        // 最後一次嘗試：如果編輯區有值但函數未定義，延遲更長時間
                        if (multiLineTextarea.value && multiLineTextarea.value.trim()) {
                            setTimeout(() => {
                                if (typeof setCustomButtonState !== 'undefined') {
                                    setCustomButtonState(restoreName, restoreType, multiLineTextarea.value);
                                }
                            }, 500);
                        }
                    }
                };
                
                // 啟動恢復嘗試（延遲 150ms 確保編輯區已完成展開）
                setTimeout(() => tryRestoreState(0), 150);
            }

            multiLineTextarea.addEventListener('input', autoResizeTextarea);
            // 設置編輯區變化監聽器（用於更新自定義範圍按鈕狀態）
            // 延遲調用，確保函數已定義
            setTimeout(() => {
                if (typeof setupTextareaWatcher !== 'undefined') {
                    setupTextareaWatcher();
                }
            }, 0);

            const getFileNamePatterns = () => {
                const isActuallyExpanded = multiLineTextarea.style.display === 'block';
                return isActuallyExpanded ? multiLineTextarea.value : singleLineInput.value;
            };

            const createLeftButton = (title, subtitle, description) => {
                const btn = document.createElement('button');
                btn.style.cssText = `display: flex; align-items: center; padding: 5px 15px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer; width: 100%; min-height: 70px;`;
                btn.innerHTML = `<div><div style="font-weight: 600;">${title}</div><div style="font-size: 12px;">${subtitle}</div><div style="font-size: 11px;">${description}</div></div>`;
                return btn;
            };
            
            const createRightButton = (text) => {
                const btn = document.createElement('button');
                btn.textContent = text;
                btn.style.cssText = `width:100%; padding:0 10px; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:8px; cursor:pointer; min-height:70px; font-weight:500;`;
                return btn;
            };
            
            const createDoubleRow = (leftContent, rightContent) => {
                const row = document.createElement('div');
                row.style.cssText = `display: flex; gap: 10px; margin-bottom: 10px;`;
                const leftDiv = document.createElement('div');
                leftDiv.style.cssText = `flex: 3;`;
                leftDiv.appendChild(leftContent);
                const rightDiv = document.createElement('div');
                rightDiv.style.cssText = `flex: 1;`;
                rightDiv.appendChild(rightContent);
                row.appendChild(leftDiv);
                row.appendChild(rightDiv);
                return row;
            };
            
            const optionsContainer = document.createElement('div');
            optionsContainer.style.cssText = `margin-bottom: 20px;`;
            
            const presetLeft = createLeftButton('📚 預定範圍', '初始默認預定範圍', '在預定義的文件範圍內搜索');
            const presetRight = createRightButton('預定(原生)');
            const customLeft = createLeftButton('🔍 自定義範圍', '文件名匹配 + 內容搜索', '在文件名匹配任一行的文件中搜索');
            const customRight = createRightButton('自定義(原生)');
            // 保存 customLeft 按鈕的引用，以便後續更新其內容
            let customLeftButtonRef = customLeft;
            let customLeftRightButtonRef = customRight;
            
            const row1 = createDoubleRow(presetLeft, presetRight);
            const row2 = createDoubleRow(customLeft, customRight);

            optionsContainer.appendChild(row1);
            optionsContainer.appendChild(row2);
            modal.appendChild(optionsContainer);

            // ========== 自定義範圍按鈕狀態管理函數 ==========
            // 更新自定義範圍按鈕狀態的函數
            const updateCustomButtonState = (state) => {
                if (!customLeftButtonRef) return;
                
                if (state.active) {
                    const modifiedText = state.isModified ? "(已修改)" : "(未修改)";
                    customLeftButtonRef.innerHTML = `<div><div style="font-weight: 600;">🔍 自定義範圍 📌</div><div style="font-size: 12px;">已應用：${state.rangeName}${modifiedText}</div><div style="font-size: 11px;">在文件名匹配任一行的文件中搜索</div></div>`;
                } else {
                    customLeftButtonRef.innerHTML = `<div><div style="font-weight: 600;">🔍 自定義範圍</div><div style="font-size: 12px;">文件名匹配 + 內容搜索</div><div style="font-size: 11px;">在文件名匹配任一行的文件中搜索</div></div>`;
                }
            };

            // 清除自定義範圍狀態的函數（當編輯區被清空或手動修改時調用）
            const clearCustomButtonState = () => {
                if (customButtonState.active) {
                    customButtonState.active = false;
                    customButtonState.rangeName = "";
                    customButtonState.rangeType = "";
                    customButtonState.originalPatternsRaw = "";
                    customButtonState.isModified = false;
                    updateCustomButtonState(customButtonState);
                }
            };
            
            // 比較編輯區內容是否與原始內容相同（過濾空白行和註釋行）
            const compareWithOriginal = (currentText, originalText) => {
                const normalizePatterns = (text) => {
                    if (!text || !text.trim()) return [];
                    const lines = text.split(/\r?\n/);
                    const result = [];
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed && !trimmed.startsWith('#')) {
                            result.push(trimmed);
                        }
                    }
                    return result;
                };
                
                const currentPatterns = normalizePatterns(currentText);
                const originalPatterns = normalizePatterns(originalText);
                
                if (currentPatterns.length !== originalPatterns.length) return false;
                for (let i = 0; i < currentPatterns.length; i++) {
                    if (currentPatterns[i] !== originalPatterns[i]) return false;
                }
                return true;
            };
            
            // 設置自定義範圍狀態的函數
            const setCustomButtonState = (rangeName, rangeType, originalPatternsText) => {
                customButtonState.active = true;
                customButtonState.rangeName = rangeName;
                customButtonState.rangeType = rangeType;
                customButtonState.originalPatternsRaw = originalPatternsText;
                customButtonState.isModified = false;
                updateCustomButtonState(customButtonState);
            };
            
            // 監聽編輯區變化，更新修改狀態
            const setupTextareaWatcher = () => {
                const checkAndUpdateModification = () => {
                    if (!customButtonState.active) return;
                    
                    const currentText = multiLineTextarea.value;
                    const isCurrentlyModified = !compareWithOriginal(currentText, customButtonState.originalPatternsRaw);
                    
                    // 如果編輯區為空，清除狀態
                    if (!currentText.trim()) {
                        clearCustomButtonState();
                        return;
                    }
                    
                    if (isCurrentlyModified !== customButtonState.isModified) {
                        customButtonState.isModified = isCurrentlyModified;
                        updateCustomButtonState(customButtonState);
                    }
                };
                
                multiLineTextarea.addEventListener('input', checkAndUpdateModification);
            };
            // ========== 函數定義結束 ==========

            const bottomRow = document.createElement('div');
            bottomRow.style.cssText = `display: flex; gap: 10px; margin-top: 16px;`;
            
            const customFileBtn = document.createElement('button');
            customFileBtn.textContent = '📁 常用文件';
            customFileBtn.style.cssText = `flex:1; padding: 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer;`;
            
            const handwriteBtn = document.createElement('button');
            handwriteBtn.textContent = '✍️ 手寫searchQuery';
            handwriteBtn.style.cssText = `flex:1; padding: 10px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer;`;
            
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = `flex:1; padding: 10px; background: transparent; border: 1px solid var(--background-modifier-border); border-radius: 8px; cursor: pointer;`;
            
            bottomRow.appendChild(customFileBtn);
            bottomRow.appendChild(handwriteBtn);
            bottomRow.appendChild(cancelBtn);
            modal.appendChild(bottomRow);
            
            document.body.appendChild(modal);

            let currentPresetButton = presetLeft;
            let currentPresetRightButton = presetRight;
            
            const updatePresetButtonAppearance = async () => {
                const storageData = await this.loadCustomFileGroups();
                const defaultPreset = storageData.defaultPreset;
                if (defaultPreset && (storageData.groups[defaultPreset.name] || storageData.combinations[defaultPreset.name])) {
                    currentPresetButton.innerHTML = `<div><div style="font-weight: 600;">📚 預定範圍 ⭐</div><div style="font-size: 12px;">默認：${defaultPreset.name}</div><div style="font-size: 11px;">在默認範圍內搜索</div></div>`;
                } else {
                    currentPresetButton.innerHTML = `<div><div style="font-weight: 600;">📚 預定範圍</div><div style="font-size: 12px;">初始默認預定範圍</div><div style="font-size: 11px;">在預定義的文件範圍內搜索</div></div>`;
                }
            };
            
            updatePresetButtonAppearance();

            presetLeft.onclick = async () => {
                const finalSearchText = searchTextInput.value.trim();
                const isBooleanQuery = booleanQueryCheckbox.checked;
                const enableDiacriticIgnore = diacriticIgnoreCheckbox.checked;
                const enableHtmlTagIgnore = htmlTagIgnoreCheckbox.checked;
                if (!finalSearchText) { new Notice('請輸入搜索內容'); return; }
                await navigator.clipboard.writeText(finalSearchText);
                if (patternTooltip) patternTooltip.remove();
                const storageData = await this.loadCustomFileGroups();
                const defaultPreset = storageData.defaultPreset;
                let rangeDisplay = null;
                let rangeRef = null;
                if (defaultPreset) {
                    if (defaultPreset.type === 'group') {
                        rangeDisplay = `組：${defaultPreset.name}`;
                        rangeRef = { type: "group", name: defaultPreset.name, patternsText: null };
                    } else if (defaultPreset.type === 'combination') {
                        rangeDisplay = `組合：${defaultPreset.name}`;
                        rangeRef = { type: "combination", name: defaultPreset.name, patternsText: null };
                    }
                } else {
                    rangeRef = { type: "default", name: null, patternsText: null };
                }
                modal.remove();
                resolve({ type: 'preset_a', searchText: finalSearchText, presetPatterns: [], rangeDisplay: rangeDisplay, rangeRef: rangeRef, isBooleanQuery: isBooleanQuery, enableDiacriticIgnore: enableDiacriticIgnore, enableHtmlTagIgnore: enableHtmlTagIgnore });
            };

            presetRight.onclick = async () => {
                const finalSearchText = searchTextInput.value.trim();
                const isBooleanQuery = booleanQueryCheckbox.checked;
                const enableDiacriticIgnore = diacriticIgnoreCheckbox.checked;
                const enableHtmlTagIgnore = htmlTagIgnoreCheckbox.checked;
                if (!finalSearchText) { new Notice('請輸入搜索內容'); return; }
                await navigator.clipboard.writeText(finalSearchText);
                if (patternTooltip) patternTooltip.remove();
                const storageData = await this.loadCustomFileGroups();
                const defaultPreset = storageData.defaultPreset;
                let rangeRef = null;
                if (defaultPreset) {
                    if (defaultPreset.type === 'group') {
                        rangeRef = { type: "group", name: defaultPreset.name, patternsText: null };
                    } else if (defaultPreset.type === 'combination') {
                        rangeRef = { type: "combination", name: defaultPreset.name, patternsText: null };
                    }
                } else {
                    rangeRef = { type: "default", name: null, patternsText: null };
                }
                modal.remove();
                resolve({ type: 'preset_b', searchText: finalSearchText, presetPatterns: [], rangeRef: rangeRef, isBooleanQuery: isBooleanQuery, enableHtmlTagIgnore: enableHtmlTagIgnore });
            };

            customLeft.onclick = async () => {
                clearCustomButtonState(); // 清除自定義範圍按鈕的 📌 狀態
                const finalSearchText = searchTextInput.value.trim();
                const isBooleanQuery = booleanQueryCheckbox.checked;
                const enableDiacriticIgnore = diacriticIgnoreCheckbox.checked;
                const enableHtmlTagIgnore = htmlTagIgnoreCheckbox.checked;
                let finalFileNamePatterns = getFileNamePatterns().trim();
                if (!finalSearchText) { new Notice('請輸入搜索內容'); return; }
                if (!finalFileNamePatterns) { new Notice('請填寫文件名匹配模式'); return; }
                await navigator.clipboard.writeText(finalSearchText);
                if (patternTooltip) patternTooltip.remove();
                
                // 判斷是否修改
                let rangeDisplay = null;
                let rangeRef = null;
                if (this.pendingRangeInfo) {
                    const currentPatterns = parsePatternsToRegexArray(finalFileNamePatterns);
                    const originalPatterns = this.pendingRangeInfo.originalPatterns;
                    
                    // 比較模式是否相同
                    const isModified = !this.arraysEqual(currentPatterns, originalPatterns);
                    
                    if (isModified) {
                        // 修改版：保存 patternsText 快照
                        rangeRef = { 
                            type: this.pendingRangeInfo.type,
                            name: this.pendingRangeInfo.name, 
                            patternsText: finalFileNamePatterns 
                        };
                        rangeDisplay = `${this.pendingRangeInfo.rangeType}：${this.pendingRangeInfo.name}（改）`;
                    } else {
                        // 未修改：動態引用
                        rangeRef = { 
                            type: this.pendingRangeInfo.type,
                            name: this.pendingRangeInfo.name, 
                            patternsText: null 
                        };
                        rangeDisplay = `${this.pendingRangeInfo.rangeType}：${this.pendingRangeInfo.name}`;
                    }
                    this.pendingRangeInfo = null;
                } else {
                    // 完全自定義
                    rangeRef = { type: "custom", name: null, patternsText: finalFileNamePatterns };
                    rangeDisplay = "自訂";
                }
                
                modal.remove();
                resolve({ type: 'custom_a', searchText: finalSearchText, fileName: finalFileNamePatterns, rangeDisplay: rangeDisplay, rangeRef: rangeRef, isBooleanQuery: isBooleanQuery, enableDiacriticIgnore: enableDiacriticIgnore, enableHtmlTagIgnore: enableHtmlTagIgnore });
            };
            
            customRight.onclick = async () => {
                clearCustomButtonState(); // 清除自定義範圍按鈕的 📌 狀態
                const finalSearchText = searchTextInput.value.trim();
                const isBooleanQuery = booleanQueryCheckbox.checked;
                const enableDiacriticIgnore = diacriticIgnoreCheckbox.checked;
                const enableHtmlTagIgnore = htmlTagIgnoreCheckbox.checked;
                const finalFileNamePatterns = getFileNamePatterns().trim();
                if (!finalSearchText) { new Notice('請輸入搜索內容'); return; }
                if (!finalFileNamePatterns) { new Notice('請填寫文件名匹配模式'); return; }
                await navigator.clipboard.writeText(finalSearchText);
                if (patternTooltip) patternTooltip.remove();
                
                // 構造 rangeRef
                let rangeRef = null;
                if (this.pendingRangeInfo) {
                    const currentPatterns = parsePatternsToRegexArray(finalFileNamePatterns);
                    const originalPatterns = this.pendingRangeInfo.originalPatterns;
                    const isModified = !this.arraysEqual(currentPatterns, originalPatterns);
                    
                    if (isModified) {
                        rangeRef = { 
                            type: this.pendingRangeInfo.type,
                            name: this.pendingRangeInfo.name, 
                            patternsText: finalFileNamePatterns 
                        };
                    } else {
                        rangeRef = { 
                            type: this.pendingRangeInfo.type,
                            name: this.pendingRangeInfo.name, 
                            patternsText: null 
                        };
                    }
                    this.pendingRangeInfo = null;
                } else {
                    rangeRef = { type: "custom", name: null, patternsText: finalFileNamePatterns };
                }
                
                modal.remove();
                resolve({ type: 'custom_b', searchText: finalSearchText, fileName: finalFileNamePatterns, rangeRef: rangeRef, isBooleanQuery: isBooleanQuery, enableHtmlTagIgnore: enableHtmlTagIgnore });
            };

            customFileBtn.onclick = async () => {
                if (patternTooltip) patternTooltip.remove();
                const currentSearchText = searchTextInput.value.trim();
                const result = await this.showCustomFileGroupsDialog(selectedText, currentSearchText || selectedText);
                if (result) {
                    if (result.action === 'closed') {
                        await updatePresetButtonAppearance();
                        return;
                    } else if (result.action === 'apply_to_custom') {
                        // 調用公共函數
                        applyGroupOrCombinationToCustomRange(result.rangeName, result.rangeType, result.patternsText, result.originalPatterns);
                        return;
                    }
                }
            };

            handwriteBtn.onclick = async () => {
                const currentSearchText = searchTextInput.value.trim();
                const isBooleanQuery = booleanQueryCheckbox.checked;
                if (!currentSearchText) {
                    new Notice('請輸入搜索內容');
                    return;
                }
                
                // 根據當前高亮狀態決定使用哪個範圍生成查詢
                const isActuallyExpanded = multiLineTextarea.style.display === 'block';
                const hasCustomContent = isActuallyExpanded ? multiLineTextarea.value.trim() : singleLineInput.value.trim();
                let searchQuery = null;
                
                if (hasCustomContent) {
                    // 自定義範圍模式：使用編輯區的內容生成查詢
                    const patternsText = getFileNamePatterns().trim();
                    if (patternsText) {
                        searchQuery = buildNativeSearchQuery(currentSearchText, patternsText, false, isBooleanQuery);
                    }
                } else {
                    // 預定範圍模式：使用默認預定範圍生成查詢
                    const defaultPatterns = this.settings.defaultFilePatterns;
                    if (defaultPatterns && defaultPatterns.length > 0) {
                        // 將字符串模式轉換為正則數組（與預設模式一致）
                        const patternsArray = defaultPatterns.map(p => {
                            try {
                                return new RegExp(p);
                            } catch(e) {
                                return null;
                            }
                        }).filter(p => p !== null);
                        if (patternsArray.length > 0) {
                            searchQuery = buildNativeSearchQuery(currentSearchText, patternsArray, true, isBooleanQuery);
                        }
                    }
                    
                    // 如果還是沒有生成查詢，只生成內容查詢
                    if (!searchQuery) {
                        if (isBooleanQuery) {
                            searchQuery = convertBooleanToNative(currentSearchText);
                        } else {
                            const isRegex = isRegexPattern(currentSearchText);
                            searchQuery = isRegex ? `/${currentSearchText}/` : `(${currentSearchText})`;
                        }
                    }
                }

                if (!searchQuery) {
                    new Notice('無法生成搜索查詢，請檢查文件名模式');
                    return;
                }
                
                if (patternTooltip) patternTooltip.remove();
                modal.remove();
                await this.showHandwriteQueryDialog(currentSearchText, getFileNamePatterns(), searchQuery);
                resolve(null);
            };

            cancelBtn.onclick = () => {
                if (patternTooltip) patternTooltip.remove();
                this.pendingRangeInfo = null;  // 清理待處理範圍信息
                modal.remove();
                resolve(null);
            };
            
            // 保存 dialogRefs 到 modal 对象上，供外部更新使用
            modal._dialogRefs = {
                searchTextInput: searchTextInput,
                booleanQueryCheckbox: booleanQueryCheckbox,
                diacriticIgnoreCheckbox: diacriticIgnoreCheckbox,
                htmlTagIgnoreCheckbox: htmlTagIgnoreCheckbox,
                singleLineInput: singleLineInput,
                multiLineTextarea: multiLineTextarea,
                isExpanded: isExpanded,  // 保留但建議不再使用（向後兼容）
                expandToMultiLine: expandToMultiLine,
                autoResizeTextarea: autoResizeTextarea,
                clearCustomButtonState: clearCustomButtonState,
                setCustomButtonState: setCustomButtonState,
                updateButtonHighlight: updateButtonHighlight,
                getFileNamePatterns: getFileNamePatterns,
                customButtonState: customButtonState,
            };

            searchTextInput.focus();
            searchTextInput.select();
        });
    }

    // 輔助函數：比較兩個正則數組是否相同
    arraysEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].source !== b[i].source) return false;
        }
        return true;
    }

    // 顯示自定義文件組彈窗
    async showCustomFileGroupsDialog(selectedText, currentSearchText = null) {
        const effectiveSearchText = currentSearchText !== null ? currentSearchText : selectedText;
        const plugin = this;
        let storageData = await this.loadCustomFileGroups();
        let groups = storageData.groups || {};
        let combinations = storageData.combinations || {};
        let defaultPreset = storageData.defaultPreset || null;
        
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: var(--background-primary);
                border-radius: 12px;
                padding: 24px;
                z-index: 10000;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                width: 700px;
                max-width: 90vw;
                max-height: 85vh;
                overflow-y: auto;
                border: 1px solid var(--background-modifier-border);
            `;
            
            const title = document.createElement('div');
            title.textContent = '📁 自定義文件組';
            title.style.cssText = `font-size: 18px; font-weight: 600; margin-bottom: 20px; text-align: center;`;
            modal.appendChild(title);
            
            const tabContainer = document.createElement('div');
            tabContainer.style.cssText = `display: flex; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 16px;`;

            const groupsTab = document.createElement('button');
            groupsTab.textContent = '📚 文件組';
            groupsTab.style.cssText = `padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-normal); font-weight: 500; border-bottom: 2px solid var(--interactive-accent);`;
            
            const combinationsTab = document.createElement('button');
            combinationsTab.textContent = '🔗 組合';
            combinationsTab.style.cssText = `padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;`;
            
            const defaultRangeTab = document.createElement('button');
            defaultRangeTab.textContent = '📖 預定範圍';
            defaultRangeTab.style.cssText = `padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;`;
            
            const helpTab = document.createElement('button');
            helpTab.textContent = '📖 說明';
            helpTab.style.cssText = `padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;`;
            
            tabContainer.appendChild(groupsTab);
            tabContainer.appendChild(combinationsTab);
            tabContainer.appendChild(defaultRangeTab);
            tabContainer.appendChild(helpTab);
            modal.appendChild(tabContainer);

            const groupsPanel = document.createElement('div');
            groupsPanel.style.cssText = `display: block;`;
            const combinationsPanel = document.createElement('div');
            combinationsPanel.style.cssText = `display: none;`;
            const defaultRangePanel = document.createElement('div');
            defaultRangePanel.style.cssText = `display: none;`;
            const helpPanel = document.createElement('div');
            helpPanel.style.cssText = `display: none; overflow-y: auto; max-height: 480px;`;

            const helpContent = document.createElement('div');
            helpContent.style.cssText = `font-size: 13px; line-height: 1.6; padding: 4px 8px;`;
            helpContent.innerHTML = `
                <h3 style="margin-top: 0;">📖 腳本使用說明</h3>
                <p><strong>文件組</strong>：一組正則表達式模式的集合，每行一個正則，支持註釋（#開頭）。</p>
                <p><strong>組合</strong>：將多個文件組聚合在一起，形成更大的搜索範圍。</p>
                <p><strong>設為臨時默認預定範圍</strong>：將選中的文件組/組合保存為臨時默認值。</p>
                <p><strong>清除臨時默認</strong>：清除已保存的臨時默認預定範圍。</p>
                <p><strong>應用為自定義範圍</strong>：將正則模式填充到主窗口的編輯區。</p>
                <p><strong>正則提示</strong>：使用 <code>\\/</code> 表示路徑分隔符，<code>^</code> 表示開頭。</p>
            `;

            // ===== 預定範圍面板 =====
            const defaultRangeContent = document.createElement('div');
            defaultRangeContent.style.cssText = `padding: 4px 8px;`;
            
            const defaultRangeDesc = document.createElement('p');
            defaultRangeDesc.style.cssText = `font-size: 12px; color: var(--text-muted); margin-bottom: 12px;`;
            defaultRangeDesc.textContent = '每行一個正則表達式，用於匹配文件名或路徑。「預定範圍」和「快速預設範圍搜索」將默認使用這些初始模式。';
            defaultRangeContent.appendChild(defaultRangeDesc);

            const defaultRangeTextarea = document.createElement('textarea');
            defaultRangeTextarea.style.cssText = `width: 100%; min-height: 200px; font-family: monospace; font-size: 12px; padding: 8px; margin-bottom: 12px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px;`;
            defaultRangeTextarea.value = (this.settings.defaultFilePatterns || []).join('\n');
            defaultRangeContent.appendChild(defaultRangeTextarea);

            const saveDefaultRangeBtn = document.createElement('button');
            saveDefaultRangeBtn.textContent = '💾 保存為初始預定範圍';
            saveDefaultRangeBtn.style.cssText = `padding: 6px 16px; background: var(--interactive-accent); color: white; border: none; border-radius: 6px; cursor: pointer; margin-bottom: 16px;`;
            saveDefaultRangeBtn.onclick = async () => {
                const lines = defaultRangeTextarea.value.split(/\r?\n/);
                const validPatterns = [];
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        try {
                            new RegExp(trimmed);
                            validPatterns.push(trimmed);
                        } catch (e) {
                            new Notice(`⚠️ 正則錯誤: ${trimmed}`);
                        }
                    }
                }
                if (validPatterns.length > 0) {
                    this.settings.defaultFilePatterns = validPatterns;
                    await this.saveSettings();
                    this.filePatterns = validPatterns.map(p => new RegExp(p));
                    this.patternStrings = this.filePatterns.map(p => p.source);
                    new Notice(`已保存 ${validPatterns.length} 個模式到預定範圍`);
                } else {
                    new Notice("請至少輸入一個有效的正則表達式");
                }
            };
            defaultRangeContent.appendChild(saveDefaultRangeBtn);

            const defaultRangeHint = document.createElement('div');
            defaultRangeHint.style.cssText = `font-size: 11px; color: var(--text-faint); padding: 8px; background: var(--background-secondary); border-radius: 6px;`;
            defaultRangeHint.innerHTML = `
                <strong>📖 正則提示：</strong><br>
                • 純文件名匹配：<code>(books|mynotes)[\\d-]+\\.md</code><br>
                • 路徑匹配（包含 / ）：<code>^kosa\\/ju\\/</code><br>
                • 註釋行以 # 開頭
            `;
            defaultRangeContent.appendChild(defaultRangeHint);

            defaultRangePanel.appendChild(defaultRangeContent);

            helpPanel.appendChild(helpContent);

            let currentGroups = groups;
            let currentCombinations = combinations;
            let currentDefaultPreset = defaultPreset;
            
            const itemSelect = document.createElement('select');
            itemSelect.style.cssText = `width: 100%; padding: 6px; margin-bottom: 12px;`;
            
            const updateItemSelect = () => {
                const currentValue = itemSelect.value;
                itemSelect.innerHTML = '<option value="">-- 請選擇 --</option>';
                itemSelect.innerHTML += '<optgroup label="📚 文件組">';
                for (const groupName of Object.keys(currentGroups)) {
                    itemSelect.innerHTML += `<option value="group:${groupName}" ${currentValue === `group:${groupName}` ? 'selected' : ''}>📂 ${groupName}</option>`;
                }
                itemSelect.innerHTML += '</optgroup><optgroup label="🔗 組合">';
                for (const comboName of Object.keys(currentCombinations)) {
                    itemSelect.innerHTML += `<option value="combination:${comboName}" ${currentValue === `combination:${comboName}` ? 'selected' : ''}>🔗 ${comboName}</option>`;
                }
                itemSelect.innerHTML += '</optgroup>';
            };

            // ========== 共用改名函數 ==========
            /**
             * 重命名文件組或組合（立即保存）
             * @param {string} type - 'group' 或 'combination'
             * @param {string} oldName - 舊名稱
             * @param {string} newName - 新名稱
             */
            const renameItem = async (type, oldName, newName) => {
                if (type === 'group') {
                    // 獲取原始順序
                    const groupNames = Object.keys(currentGroups);
                    // 按原始順序重新構建對象
                    const newGroups = {};
                    for (const name of groupNames) {
                        if (name === oldName) {
                            newGroups[newName] = currentGroups[oldName];
                        } else {
                            newGroups[name] = currentGroups[name];
                        }
                    }
                    currentGroups = newGroups;
                    
                    // 更新組合中的引用
                    for (const combo of Object.values(currentCombinations)) {
                        if (combo.groups && combo.groups.includes(oldName)) {
                            const idx = combo.groups.indexOf(oldName);
                            combo.groups[idx] = newName;
                        }
                    }
                    
                    // 更新默認預定範圍
                    if (currentDefaultPreset && currentDefaultPreset.type === 'group' && currentDefaultPreset.name === oldName) {
                        currentDefaultPreset.name = newName;
                    }
                } else if (type === 'combination') {
                    // 獲取原始順序
                    const comboNames = Object.keys(currentCombinations);
                    // 按原始順序重新構建對象
                    const newCombinations = {};
                    for (const name of comboNames) {
                        if (name === oldName) {
                            newCombinations[newName] = currentCombinations[oldName];
                        } else {
                            newCombinations[name] = currentCombinations[name];
                        }
                    }
                    currentCombinations = newCombinations;
                    
                    // 更新默認預定範圍
                    if (currentDefaultPreset && currentDefaultPreset.type === 'combination' && currentDefaultPreset.name === oldName) {
                        currentDefaultPreset.name = newName;
                    }
                }
                
                // 更新歷史搜索記錄
                const history = plugin.settings.searchHistory;
                if (history && history.items) {
                    for (const item of history.items) {
                        if (item.rangeRef && item.rangeRef.type === type && item.rangeRef.name === oldName) {
                            item.rangeRef.name = newName;
                        }
                    }
                }
                
                // 更新當前打開的結果面板
                const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH_RESULT)[0]?.view;
                if (view && view.currentRangeRef && view.currentRangeRef.type === type && view.currentRangeRef.name === oldName) {
                    view.currentRangeRef.name = newName;
                    if (view.currentRangeDisplay) {
                        view.currentRangeDisplay = view.currentRangeDisplay.replace(oldName, newName);
                    }
                    view.refreshDisplay();
                }
                
                // 立即保存到 data.json
                await plugin.saveCustomFileGroups({ 
                    groups: currentGroups, 
                    combinations: currentCombinations, 
                    defaultPreset: currentDefaultPreset 
                });
                
                // 刷新面板
                renderGroupsPanel();
                renderCombinationsPanel();
                updateItemSelect();
                
                new Notice(`已將「${oldName}」改名為「${newName}」`);
            };

            const renderGroupsPanel = () => {
                groupsPanel.innerHTML = '';
                const groupsContainer = document.createElement('div');
                groupsContainer.style.cssText = `max-height: 400px; overflow-y: auto; margin-bottom: 16px;`;
                
                if (currentDefaultPreset && currentDefaultPreset.type === 'group' && currentGroups[currentDefaultPreset.name]) {
                    const defaultHint = document.createElement('div');
                    defaultHint.style.cssText = `background: var(--background-secondary); border-radius: 6px; padding: 6px 12px; margin-bottom: 12px; font-size: 12px; color: var(--text-accent);`;
                    defaultHint.textContent = `⭐ 當前默認預定範圍：${currentDefaultPreset.name}（文件組）`;
                    groupsContainer.appendChild(defaultHint);
                } else if (currentDefaultPreset && currentDefaultPreset.type === 'combination' && currentCombinations[currentDefaultPreset.name]) {
                    const defaultHint = document.createElement('div');
                    defaultHint.style.cssText = `background: var(--background-secondary); border-radius: 6px; padding: 6px 12px; margin-bottom: 12px; font-size: 12px; color: var(--text-accent);`;
                    defaultHint.textContent = `⭐ 當前默認預定範圍：${currentDefaultPreset.name}（組合）`;
                    groupsContainer.appendChild(defaultHint);
                }
                
                for (const [groupName, group] of Object.entries(currentGroups)) {
                    const groupCard = document.createElement('div');
                    groupCard.style.cssText = `border: 1px solid var(--background-modifier-border); border-radius: 8px; margin-bottom: 12px;`;
                    
                    let isCollapsed = true;
                    const header = document.createElement('div');
                    header.style.cssText = `display: flex; justify-content: space-between; align-items: center; padding: 2px 10px; cursor: pointer; border-radius: 8px; font-weight: 600;`;
                    
                    const titleLeft = document.createElement('div');
                    titleLeft.style.cssText = `display: flex; align-items: center; gap: 8px;`;
                    const toggleIcon = document.createElement('span');
                    toggleIcon.textContent = '▶';
                    const titleText = document.createElement('span');
                    titleText.innerHTML = `📂 ${groupName}`;
                    titleLeft.appendChild(toggleIcon);
                    titleLeft.appendChild(titleText);
                    
                    const btnGroup = document.createElement('div');
                    btnGroup.style.cssText = `display: flex; gap: 6px;`;
                    // 編輯按鈕（放在刪除按鈕左邊）
                    const editBtn = document.createElement('button');
                    editBtn.textContent = '✏️';
                    editBtn.style.cssText = `padding: 2px 8px; font-size: 11px; cursor: pointer;`;
                    editBtn.onclick = async (e) => {
                        e.stopPropagation();
                        const inputModal = document.createElement('div');
                        inputModal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--background-primary); border-radius: 12px; padding: 24px; z-index: 10001; min-width: 300px; border: 1px solid var(--background-modifier-border);`;
                        inputModal.innerHTML = `<div style="margin-bottom:12px;">請輸入新的文件組名稱：</div><input type="text" style="width:100%; padding:8px; margin-bottom:16px;" value="${groupName}"><div style="display:flex; gap:10px; justify-content:flex-end;"><button id="ok" style="padding:6px 16px;">確定</button><button id="cancel" style="padding:6px 16px;">取消</button></div>`;
                        document.body.appendChild(inputModal);
                        const input = inputModal.querySelector('input');
                        input.focus();
                        input.select();
                        inputModal.querySelector('#ok').onclick = async () => {
                            const newName = input.value.trim();
                            if (!newName) {
                                new Notice('名稱不能為空');
                                inputModal.remove();
                                return;
                            }
                            if (newName === groupName) {
                                inputModal.remove();
                                return;
                            }
                            if (currentGroups[newName]) {
                                new Notice(`文件組「${newName}」已存在`);
                                inputModal.remove();
                                return;
                            }
                            await renameItem('group', groupName, newName);
                            inputModal.remove();
                        };
                        inputModal.querySelector('#cancel').onclick = () => inputModal.remove();
                    };
                    btnGroup.appendChild(editBtn);
                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = '刪除';
                    deleteBtn.style.cssText = `padding: 2px 8px; font-size: 11px;`;
                    deleteBtn.onclick = async (e) => {
                        e.stopPropagation();
                        delete currentGroups[groupName];
                        await plugin.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                        renderGroupsPanel();
                        renderCombinationsPanel();
                        updateItemSelect();
                    };
                    btnGroup.appendChild(deleteBtn);

                    header.appendChild(titleLeft);
                    header.appendChild(btnGroup);
                    
                    const contentArea = document.createElement('div');
                    contentArea.style.cssText = `padding: 0 10px 10px 10px; display: none;`;

                    const textarea = document.createElement('textarea');
                    textarea.value = (group.patterns || []).join('\n');
                    textarea.style.cssText = `width: 100%; padding: 6px; font-family: monospace; font-size: 12px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 4px; color: var(--text-normal); resize: vertical; overflow-y: auto; max-height: 80px; min-height: 40px;`;
                    
                    const autoResizeTextarea = () => {
                        textarea.style.height = 'auto';
                        const newHeight = Math.min(textarea.scrollHeight, 300);
                        textarea.style.height = newHeight + 'px';
                    };
                    
                    // 初始調整高度 - 使用 setTimeout 确保 DOM 已渲染
                    setTimeout(() => autoResizeTextarea(), 0);

                    textarea.addEventListener('blur', async () => {
                        autoResizeTextarea();
                        // 保留排除行（以 ! 開頭），過濾純註釋行和空行
                        group.patterns = textarea.value.split(/\r?\n/).filter(l => {
                            const trimmed = l.trim();
                            if (!trimmed) return false;
                            if (trimmed.startsWith('#') && !trimmed.startsWith('\\#')) return false;
                            return true;
                        });
                        await plugin.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                        renderCombinationsPanel();
                    });

                    textarea.addEventListener('click', (e) => e.stopPropagation());
                    contentArea.appendChild(textarea);

                    const setCollapsed = (collapsed) => {
                        isCollapsed = collapsed;
                        if (collapsed) {
                            contentArea.style.display = 'none';
                            toggleIcon.textContent = '▶';
                            header.style.background = 'var(--background-modifier-hover)';
                        } else {
                            contentArea.style.display = 'block';
                            toggleIcon.textContent = '▼';
                            header.style.background = 'transparent';
                            // 展开时重新调整高度
                            setTimeout(() => autoResizeTextarea(), 50);
                        }
                    };

                    header.onclick = (e) => {
                        if (e.target.closest('.delete-group-btn')) return;
                        setCollapsed(!isCollapsed);
                        itemSelect.value = `group:${groupName}`;
                        updateItemSelect();
                    };
                    
                    groupCard.appendChild(header);
                    groupCard.appendChild(contentArea);
                    groupsContainer.appendChild(groupCard);
                    setCollapsed(true);
                }
                
                const addGroupBtn = document.createElement('button');
                addGroupBtn.textContent = '+ 添加新文件組';
                addGroupBtn.style.cssText = `width: 100%; padding: 8px; margin-top: 4px; border: 1px dashed var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
                addGroupBtn.onclick = async () => {
                    const inputModal = document.createElement('div');
                    inputModal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--background-primary); border-radius: 12px; padding: 24px; z-index: 10001; min-width: 300px; border: 1px solid var(--background-modifier-border);`;
                    inputModal.innerHTML = `<div style="margin-bottom:12px;">請輸入組名稱：</div><input type="text" style="width:100%; padding:8px; margin-bottom:16px;"><div style="display:flex; gap:10px; justify-content:flex-end;"><button id="ok" style="padding:6px 16px;">確定</button><button id="cancel" style="padding:6px 16px;">取消</button></div>`;
                    document.body.appendChild(inputModal);
                    const input = inputModal.querySelector('input');
                    input.focus();
                    inputModal.querySelector('#ok').onclick = async () => {
                        let newName = input.value.trim() || `組${Object.keys(currentGroups).length + 1}`;
                        if (!currentGroups[newName]) {
                            currentGroups[newName] = { patterns: [] };
                            await this.plugin.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                            renderGroupsPanel();
                            renderCombinationsPanel();
                            updateItemSelect();
                        }
                        inputModal.remove();
                    };
                    inputModal.querySelector('#cancel').onclick = () => inputModal.remove();
                };
                groupsContainer.appendChild(addGroupBtn);
                groupsPanel.appendChild(groupsContainer);
            };
            
            const renderCombinationsPanel = () => {
                combinationsPanel.innerHTML = '';
                const combosContainer = document.createElement('div');
                combosContainer.style.cssText = `max-height: 400px; overflow-y: auto; margin-bottom: 16px;`;
                
                for (const [comboName, combo] of Object.entries(currentCombinations)) {
                    const comboCard = document.createElement('div');
                    comboCard.style.cssText = `border: 1px solid var(--background-modifier-border); border-radius: 8px; margin-bottom: 12px;`;
                    
                    let isCollapsed = true;
                    const header = document.createElement('div');
                    header.style.cssText = `display: flex; justify-content: space-between; align-items: center; padding: 2px 10px; cursor: pointer; border-radius: 8px; font-weight: 600;`;
                    
                    const titleLeft = document.createElement('div');
                    titleLeft.style.cssText = `display: flex; align-items: center; gap: 8px; flex-wrap: wrap;`;
                    const toggleIcon = document.createElement('span');
                    toggleIcon.textContent = '▶';
                    const titleText = document.createElement('span');
                    titleText.innerHTML = `🔗 ${comboName}`;
                    titleText.style.cssText = `font-weight: 600;`;
                    
                    titleLeft.appendChild(toggleIcon);
                    titleLeft.appendChild(titleText);
                    
                    const btnGroup = document.createElement('div');
                    btnGroup.style.cssText = `display: flex; gap: 6px;`;
                    // 編輯按鈕（放在刪除按鈕左邊）
                    const editBtn = document.createElement('button');
                    editBtn.textContent = '✏️';
                    editBtn.style.cssText = `padding: 2px 8px; font-size: 11px; cursor: pointer;`;
                    editBtn.onclick = async (e) => {
                        e.stopPropagation();
                        const inputModal = document.createElement('div');
                        inputModal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--background-primary); border-radius: 12px; padding: 24px; z-index: 10001; min-width: 300px; border: 1px solid var(--background-modifier-border);`;
                        inputModal.innerHTML = `<div style="margin-bottom:12px;">請輸入新的組合名稱：</div><input type="text" style="width:100%; padding:8px; margin-bottom:16px;" value="${comboName}"><div style="display:flex; gap:10px; justify-content:flex-end;"><button id="ok" style="padding:6px 16px;">確定</button><button id="cancel" style="padding:6px 16px;">取消</button></div>`;
                        document.body.appendChild(inputModal);
                        const input = inputModal.querySelector('input');
                        input.focus();
                        input.select();
                        inputModal.querySelector('#ok').onclick = async () => {
                            const newName = input.value.trim();
                            if (!newName) {
                                new Notice('名稱不能為空');
                                inputModal.remove();
                                return;
                            }
                            if (newName === comboName) {
                                inputModal.remove();
                                return;
                            }
                            if (currentCombinations[newName]) {
                                new Notice(`組合「${newName}」已存在`);
                                inputModal.remove();
                                return;
                            }
                            await renameItem('combination', comboName, newName);
                            inputModal.remove();
                        };
                        inputModal.querySelector('#cancel').onclick = () => inputModal.remove();
                    };
                    btnGroup.appendChild(editBtn);
                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = '刪除';
                    deleteBtn.className = 'delete-combo-btn';
                    deleteBtn.style.cssText = `padding: 2px 8px; font-size: 11px;`;
                    deleteBtn.onclick = async (e) => {
                        e.stopPropagation();
                        delete currentCombinations[comboName];
                        await plugin.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                        renderCombinationsPanel();
                        updateItemSelect();
                    };
                    btnGroup.appendChild(deleteBtn);

                    header.appendChild(titleLeft);
                    header.appendChild(btnGroup);

                    const contentArea = document.createElement('div');
                    contentArea.style.cssText = `padding: 0 10px 10px 10px; display: none;`;
                    
                    const groupsSelectContainer = document.createElement('div');
                    groupsSelectContainer.style.cssText = `margin-bottom: 8px;`;
                    const selectedGroupsDisplay = document.createElement('div');
                    selectedGroupsDisplay.style.cssText = `display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;`;
                    
                    const updateSelectedDisplay = () => {
                        selectedGroupsDisplay.innerHTML = '';
                        for (const groupName of (combo.groups || [])) {
                            const tag = document.createElement('span');
                            tag.style.cssText = `background: var(--background-secondary); padding: 2px 8px; border-radius: 12px; font-size: 11px; display: inline-flex; align-items: center; gap: 4px;`;
                            tag.innerHTML = `${groupName} <span style="cursor:pointer;" class="remove-group" data-group="${groupName}">✖</span>`;
                            selectedGroupsDisplay.appendChild(tag);
                        }
                        // 為每個刪除按鈕綁定事件
                        selectedGroupsDisplay.querySelectorAll('.remove-group').forEach(el => {
                            el.onclick = (e) => {
                                e.stopPropagation();
                                const groupToRemove = el.getAttribute('data-group');
                                combo.groups = combo.groups.filter(g => g !== groupToRemove);
                                updateSelectedDisplay();
                                updateGroupSelect();
                            };
                        });
                    };

                    const addRow = document.createElement('div');
                    addRow.style.cssText = `display: flex; gap: 6px;`;
                    const groupSelect = document.createElement('select');
                    groupSelect.style.cssText = `flex: 1; padding: 4px;`;
                    
                    const updateGroupSelect = () => {
                        groupSelect.innerHTML = '<option value="">選擇文件組...</option>';
                        for (const groupName of Object.keys(currentGroups)) {
                            if (!(combo.groups || []).includes(groupName)) {
                                groupSelect.innerHTML += `<option value="${groupName}">${groupName}</option>`;
                            }
                        }
                    };
                    updateGroupSelect();
                    
                    const addToComboBtn = document.createElement('button');
                    addToComboBtn.textContent = '+ 添加';
                    addToComboBtn.onclick = (e) => {
                        e.stopPropagation();
                        const selectedGroup = groupSelect.value;
                        if (selectedGroup) {
                            if (!combo.groups) combo.groups = [];
                            combo.groups.push(selectedGroup);
                            updateSelectedDisplay();
                            updateGroupSelect();
                        }
                    };
                    addRow.appendChild(groupSelect);
                    addRow.appendChild(addToComboBtn);
                    
                    groupsSelectContainer.appendChild(selectedGroupsDisplay);
                    groupsSelectContainer.appendChild(addRow);
                    contentArea.appendChild(groupsSelectContainer);
                    
                    const setCollapsed = (collapsed) => {
                        isCollapsed = collapsed;
                        contentArea.style.display = collapsed ? 'none' : 'block';
                        toggleIcon.textContent = collapsed ? '▶' : '▼';
                    };

                    header.onclick = (e) => {
                        if (e.target.closest('.delete-combo-btn')) return;
                        setCollapsed(!isCollapsed);
                        itemSelect.value = `combination:${comboName}`;
                        updateItemSelect();
                    };
                    
                    comboCard.appendChild(header);
                    comboCard.appendChild(contentArea);
                    combosContainer.appendChild(comboCard);
                    setCollapsed(true);
                    
                    // 初始化顯示已選組
                    updateSelectedDisplay();
                }

                const addComboBtn = document.createElement('button');
                addComboBtn.textContent = '+ 添加新組合';
                addComboBtn.style.cssText = `width: 100%; padding: 8px; margin-top: 4px; border: 1px dashed var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
                addComboBtn.onclick = async () => {
                    const inputModal = document.createElement('div');
                    inputModal.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--background-primary); border-radius: 12px; padding: 24px; z-index: 10001; min-width: 300px; border: 1px solid var(--background-modifier-border);`;
                    inputModal.innerHTML = `<div style="margin-bottom:12px;">請輸入組合名稱：</div><input type="text" style="width:100%; padding:8px; margin-bottom:16px;"><div style="display:flex; gap:10px; justify-content:flex-end;"><button id="ok" style="padding:6px 16px;">確定</button><button id="cancel" style="padding:6px 16px;">取消</button></div>`;
                    document.body.appendChild(inputModal);
                    const input = inputModal.querySelector('input');
                    input.focus();
                    inputModal.querySelector('#ok').onclick = async () => {
                        let newName = input.value.trim() || `組合${Object.keys(currentCombinations).length + 1}`;
                        if (!currentCombinations[newName]) {
                            currentCombinations[newName] = { groups: [] };
                            await this.plugin.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                            renderCombinationsPanel();
                            updateItemSelect();
                        }
                        inputModal.remove();
                    };
                    inputModal.querySelector('#cancel').onclick = () => inputModal.remove();
                };
                combosContainer.appendChild(addComboBtn);
                combinationsPanel.appendChild(combosContainer);
            };

            renderGroupsPanel();
            renderCombinationsPanel();
            updateItemSelect();

            modal.appendChild(groupsPanel);
            modal.appendChild(combinationsPanel);
            modal.appendChild(defaultRangePanel);
            modal.appendChild(helpPanel);

            const actionContainer = document.createElement('div');
            actionContainer.style.cssText = `margin-top: 16px; border-top: 1px solid var(--background-modifier-border); padding-top: 16px;`;
            actionContainer.createEl('div', { text: '選擇要應用的項目：', attr: { style: 'margin-bottom: 8px;' } });
            actionContainer.appendChild(itemSelect);

            const actionRow = document.createElement('div');
            actionRow.style.cssText = `display: flex; gap: 10px; margin-bottom: 12px;`;
            
            const setDefaultBtn = document.createElement('button');
            setDefaultBtn.textContent = '⭐ 設為臨時默認預定範圍';
            setDefaultBtn.style.cssText = `flex:1; padding: 6px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
            setDefaultBtn.onclick = async () => {
                const val = itemSelect.value;
                if (!val) { new Notice('請先選擇一個項目'); return; }
                const [type, name] = val.split(':');
                currentDefaultPreset = { type, name };
                await this.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                new Notice(`已將「${name}」設為臨時默認預定範圍`);
                renderGroupsPanel();
                renderCombinationsPanel();
            };
            actionRow.appendChild(setDefaultBtn);
            
            const clearDefaultBtn = document.createElement('button');
            clearDefaultBtn.textContent = '🗑️ 清除臨時默認';
            clearDefaultBtn.title = '清除後，退回插件設置中的初始預定範圍';
            clearDefaultBtn.style.cssText = `flex:1; padding: 6px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
            clearDefaultBtn.onclick = async () => {
                currentDefaultPreset = null;
                await this.saveCustomFileGroups({ groups: currentGroups, combinations: currentCombinations, defaultPreset: currentDefaultPreset });
                new Notice('已清除臨時默認預定範圍');
                renderGroupsPanel();
                renderCombinationsPanel();
            };
            actionRow.appendChild(clearDefaultBtn);
            actionContainer.appendChild(actionRow);
            
            const secondRow = document.createElement('div');
            secondRow.style.cssText = `display: flex; gap: 10px; margin-bottom: 12px;`;
            
            const applyToCustomBtn = document.createElement('button');
            applyToCustomBtn.textContent = '🔍 應用為自定義範圍（本次搜索）';
            applyToCustomBtn.style.cssText = `flex:1; padding: 6px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
            applyToCustomBtn.onclick = () => {
                const val = itemSelect.value;
                if (!val) { new Notice('請先選擇一個項目'); return; }
                const [type, name] = val.split(':');
                let patternsArray = [];
                let patternsWithExclude = [];
                let rangeType = "";
                if (type === 'group') {
                    patternsArray = currentGroups[name]?.patterns || [];
                    patternsWithExclude = patternsArray;
                    rangeType = "文件組";
                } else {
                    const combo = currentCombinations[name];
                    rangeType = "組合";
                    if (combo && combo.groups) {
                        for (const gn of combo.groups) {
                            const group = currentGroups[gn];
                            if (group && group.patterns) {
                                patternsArray = patternsArray.concat(group.patterns);
                                patternsWithExclude = patternsWithExclude.concat(group.patterns);
                            }
                        }
                    }
                }
                if (patternsArray.length === 0) { new Notice('該項目沒有有效的模式'); return; }
                modal.remove();
                resolve({ 
                    action: 'apply_to_custom', 
                    patternsText: patternsWithExclude.join('\n'), 
                    searchText: effectiveSearchText,
                    rangeName: name,
                    rangeType: rangeType,
                    originalPatterns: patternsArray.map(p => new RegExp(p))
                });
            };
            secondRow.appendChild(applyToCustomBtn);

            const writeToHandwriteBtn = document.createElement('button');
            writeToHandwriteBtn.textContent = '✍️ 寫入手寫搜索查詢區';
            writeToHandwriteBtn.style.cssText = `flex:1; padding: 6px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
            writeToHandwriteBtn.onclick = () => {
                const val = itemSelect.value;
                if (!val) { new Notice('請先選擇一個項目'); return; }
                const [type, name] = val.split(':');
                let patternsArray = [];
                if (type === 'group') {
                    patternsArray = currentGroups[name]?.patterns || [];
                } else {
                    const combo = currentCombinations[name];
                    if (combo && combo.groups) {
                        for (const gn of combo.groups) {
                            const group = currentGroups[gn];
                            if (group && group.patterns) patternsArray = patternsArray.concat(group.patterns);
                        }
                    }
                }
                if (patternsArray.length === 0) { new Notice('該項目沒有有效的模式'); return; }
                const patternsText = patternsArray.join('\n');
                const searchQuery = buildNativeSearchQuery(effectiveSearchText, patternsText, false);
                if (!searchQuery) { new Notice('無法生成搜索查詢'); return; }
                modal.remove();
                resolve({ action: 'write_to_handwrite', query: searchQuery, searchText: effectiveSearchText, patternsText: patternsText });
            };
            secondRow.appendChild(writeToHandwriteBtn);
            actionContainer.appendChild(secondRow);
            
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '關閉';
            closeBtn.style.cssText = `width: 100%; padding: 6px; background: transparent; border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;`;
            closeBtn.onclick = () => { modal.remove(); resolve({ action: 'closed' }); };
            actionContainer.appendChild(closeBtn);
            
            modal.appendChild(actionContainer);
            document.body.appendChild(modal);

            groupsTab.onclick = () => {
                groupsTab.style.borderBottomColor = 'var(--interactive-accent)';
                groupsTab.style.color = 'var(--text-normal)';
                combinationsTab.style.borderBottomColor = 'transparent';
                combinationsTab.style.color = 'var(--text-muted)';
                defaultRangeTab.style.borderBottomColor = 'transparent';
                defaultRangeTab.style.color = 'var(--text-muted)';
                helpTab.style.borderBottomColor = 'transparent';
                helpTab.style.color = 'var(--text-muted)';
                groupsPanel.style.display = 'block';
                combinationsPanel.style.display = 'none';
                defaultRangePanel.style.display = 'none';
                helpPanel.style.display = 'none';
            };
            combinationsTab.onclick = () => {
                combinationsTab.style.borderBottomColor = 'var(--interactive-accent)';
                combinationsTab.style.color = 'var(--text-normal)';
                groupsTab.style.borderBottomColor = 'transparent';
                groupsTab.style.color = 'var(--text-muted)';
                defaultRangeTab.style.borderBottomColor = 'transparent';
                defaultRangeTab.style.color = 'var(--text-muted)';
                helpTab.style.borderBottomColor = 'transparent';
                helpTab.style.color = 'var(--text-muted)';
                combinationsPanel.style.display = 'block';
                groupsPanel.style.display = 'none';
                defaultRangePanel.style.display = 'none';
                helpPanel.style.display = 'none';
            };
            defaultRangeTab.onclick = () => {
                defaultRangeTab.style.borderBottomColor = 'var(--interactive-accent)';
                defaultRangeTab.style.color = 'var(--text-normal)';
                groupsTab.style.borderBottomColor = 'transparent';
                groupsTab.style.color = 'var(--text-muted)';
                combinationsTab.style.borderBottomColor = 'transparent';
                combinationsTab.style.color = 'var(--text-muted)';
                helpTab.style.borderBottomColor = 'transparent';
                helpTab.style.color = 'var(--text-muted)';
                defaultRangePanel.style.display = 'block';
                groupsPanel.style.display = 'none';
                combinationsPanel.style.display = 'none';
                helpPanel.style.display = 'none';
            };
            helpTab.onclick = () => {
                helpTab.style.borderBottomColor = 'var(--interactive-accent)';
                helpTab.style.color = 'var(--text-normal)';
                groupsTab.style.borderBottomColor = 'transparent';
                groupsTab.style.color = 'var(--text-muted)';
                combinationsTab.style.borderBottomColor = 'transparent';
                combinationsTab.style.color = 'var(--text-muted)';
                defaultRangeTab.style.borderBottomColor = 'transparent';
                defaultRangeTab.style.color = 'var(--text-muted)';
                helpPanel.style.display = 'block';
                groupsPanel.style.display = 'none';
                combinationsPanel.style.display = 'none';
                defaultRangePanel.style.display = 'none';
            };
        });
    }

    // 顯示手寫搜索查詢的彈窗 - 輔助編輯模式
    async showHandwriteQueryDialog(previousSearchText, previousFileName, prefillQuery = null) {
        return new Promise((resolve) => {
            const modal = new HandwriteQueryModal(
                this.app, 
                this, 
                previousSearchText, 
                previousFileName, 
                prefillQuery, 
                resolve
            );
            modal.open();
        });
    }

    // ==================== 搜索執行函數 ====================
    
    async handleSearch(editor) {
        const selectedText = editor.getSelection().trim();
        // 如果有選中文本，複製到剪貼板（方便用戶粘貼）
        if (selectedText) {
            await navigator.clipboard.writeText(selectedText);
        }
        
        const result = await this.showSearchModeDialog(selectedText);
        if (!result) return;
        
        await this.executeSearchFromDialogResult(result, { useEmptyPresetPatterns: true });
    }
    
    async quickPresetSearch(editor) {
        const selectedText = editor.getSelection().trim();
        if (!selectedText) {
            new Notice("未選中文本，直接打開搜索面板");
            await this.handleSearch(editor);
            return;
        }
        await navigator.clipboard.writeText(selectedText);
        // 快速預設搜索使用默認範圍
        const rangeRef = { type: "default", name: null, patternsText: null };
        // 读取全局设置中的默认值
        const isBooleanQuery = this.settings.enableBooleanQuery || false;
        const enableDiacriticIgnore = this.settings.enableDiacriticIgnore || false;
        const enableHtmlTagIgnore = this.settings.enableHtmlTagIgnore || false;
        await this.searchAndShowInSidebar(selectedText, [], true, null, false, rangeRef, isBooleanQuery, enableDiacriticIgnore, enableHtmlTagIgnore);
    }
}

// ==================== 設置標籤頁 ====================
class CustomSearchSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.currentTab = "search";
    }

    /**
     * 創建可拖拽的列表行
     * @param {HTMLElement} container - 父容器
     * @param {Array} items - 數據數組
     * @param {number} index - 當前項的索引
     * @param {Function} onReorder - 排序完成後的回調 (fromIndex, toIndex) => void
     * @param {boolean} isDraggable - 該行是否可拖拽（排除行為 false）
     * @param {string} displayText - 顯示的文字
     * @param {string} displayStyle - 顯示文字的樣式
     * @returns {HTMLElement} 創建的行元素
     */
    createDraggableRow(container, items, index, onReorder, isDraggable, displayText, displayStyle = "") {
        const row = container.createEl("div", {
            attr: { style: "display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--background-secondary); border-radius: 6px;" }
        });
        
        // 拖拽手柄
        const dragHandle = row.createEl("span", {
            text: "⋮⋮",
            attr: { 
                draggable: isDraggable ? "true" : "false",
                style: `color: var(--text-muted); font-size: 16px; user-select: none; ${isDraggable ? 'cursor: grab;' : 'opacity: 0.3;'}`
            }
        });
        
        if (isDraggable) {
            dragHandle.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', index);
                e.dataTransfer.effectAllowed = 'move';
                dragHandle.style.cursor = 'grabbing';
            });
            
            dragHandle.addEventListener('dragend', () => {
                dragHandle.style.cursor = 'grab';
            });
        }
        
        // 顯示文字
        const textSpan = row.createEl("span", {
            text: displayText,
            attr: { style: `flex: 1; font-size: 13px; ${displayStyle}` }
        });
        
        // 放置目標事件（只有可拖拽行才能接收放置）
        if (isDraggable) {
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                const toIndex = index;
                if (fromIndex !== toIndex && !isNaN(fromIndex)) {
                    onReorder(fromIndex, toIndex);
                }
            });
        }
        
        // 上下箭頭按鈕容器
        const arrowContainer = row.createEl("div", {
            attr: { style: "display: flex; gap: 4px;" }
        });
        
        const upBtn = arrowContainer.createEl("button", {
            text: "↑",
            attr: { style: `padding: 2px 6px; font-size: 11px; ${isDraggable ? 'cursor: pointer;' : 'opacity: 0.3; cursor: default;'}` }
        });
        
        const downBtn = arrowContainer.createEl("button", {
            text: "↓",
            attr: { style: `padding: 2px 6px; font-size: 11px; ${isDraggable ? 'cursor: pointer;' : 'opacity: 0.3; cursor: default;'}` }
        });
        
        if (isDraggable) {
            upBtn.onclick = () => {
                if (index > 0) {
                    onReorder(index, index - 1);
                }
            };
            
            downBtn.onclick = () => {
                if (index < items.length - 1) {
                    onReorder(index, index + 1);
                }
            };
        }
        
        return row;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "custom-search插件設置" });

        // ===== 創建選項卡 =====
        const tabContainer = containerEl.createEl("div", {
            attr: { style: "display: flex; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 20px; margin-top: 10px;" }
        });

        // 定義選項卡
        const tabs = [
            { id: "search", name: "📊 搜索設置" },
            { id: "priority", name: "📁 優先級設置" },
            { id: "history", name: "📜 歷史管理" },
            { id: "colors", name: "🎨 顏色外觀" },
            { id: "help", name: "ℹ️ 說明" }
        ];

        // 存儲面板元素
        const panels = {};

        // 創建所有面板（先隱藏）
        for (const tab of tabs) {
            const panel = containerEl.createEl("div", {
                attr: { style: "display: none;" }
            });
            panels[tab.id] = panel;
        }

        // 創建選項卡按鈕並綁定事件
        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            const btn = tabContainer.createEl("button", {
                text: tab.name,
                attr: {
                    style: "padding: 8px 16px; background: transparent; border: none; cursor: pointer; color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;"
                }
            });
            
            // 綁定點擊事件 - 使用閉包捕獲當前的 tabId
            const tabId = tab.id;
            btn.onclick = () => {
                // 記錄當前標簽
                this.currentTab = tabId;
                // 重置所有按鈕樣式
                for (const btnEl of tabContainer.children) {
                    btnEl.style.color = "var(--text-muted)";
                    btnEl.style.borderBottomColor = "transparent";
                }
                // 激活當前按鈕
                btn.style.color = "var(--text-normal)";
                btn.style.borderBottomColor = "var(--interactive-accent)";
                // 顯示對應面板，隱藏其他
                for (const [id, panel] of Object.entries(panels)) {
                    panel.style.display = id === tabId ? "block" : "none";
                }
            };
            
            // 根據保存的標簽決定哪個激活
            if (tabId === this.currentTab) {
                btn.style.color = "var(--text-normal)";
                btn.style.borderBottomColor = "var(--interactive-accent)";
                panels[tabId].style.display = "block";
            }
        }

        // ==================== 選項卡1：搜索設置 ====================
        const searchPanel = panels.search;
        
        // 默認顯示模式設置
        new Setting(searchPanel)
            .setName("默認顯示模式")
            .setDesc("設置搜索結果的默認顯示模式。A: 單行（只顯示匹配行）; B: 3行+滾動條; C: 3行+完整顯示")
            .addDropdown(dropdown => dropdown
                .addOption('A', 'A - 單行模式')
                .addOption('B', 'B - 3行+滾動條')
                .addOption('C', 'C - 3行+完整顯示')
                .setValue(this.plugin.settings.defaultDisplayMode)
                .onChange(async (value) => {
                    this.plugin.settings.defaultDisplayMode = value;
                    await this.plugin.saveSettings();
                }));

        // 布爾查詢開關
        new Setting(searchPanel)
            .setName("布爾查詢（默認值）")
            .setDesc("啟用後，搜索內容支持 &(與)、|(或)、!(非) 及括號 ( )。")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableBooleanQuery)
                .onChange(async (value) => {
                    this.plugin.settings.enableBooleanQuery = value;
                    // 互斥：如果開啟布爾查詢，則關閉無視圖標和忽略變音
                    if (value) {
                        if (this.plugin.settings.enableHtmlTagIgnore) {
                            this.plugin.settings.enableHtmlTagIgnore = false;
                        }
                        if (this.plugin.settings.enableDiacriticIgnore) {
                            this.plugin.settings.enableDiacriticIgnore = false;
                        }
                    }
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // 無視圖標默認開關
        new Setting(searchPanel)
            .setName("無視圖標（默認值）")
            .setDesc("忽略 HTML 標簽、MD語法及標點符號")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableHtmlTagIgnore)
                .onChange(async (value) => {
                    this.plugin.settings.enableHtmlTagIgnore = value;
                    // 互斥：如果開啟無視圖標，則關閉布爾查詢
                    if (value && this.plugin.settings.enableBooleanQuery) {
                        this.plugin.settings.enableBooleanQuery = false;
                    }
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // 忽略變音默認開關
        new Setting(searchPanel)
            .setName("忽略變音（默認值）")
            .setDesc("忽略七組變音符號（a/ā/â等）")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDiacriticIgnore)
                .onChange(async (value) => {
                    this.plugin.settings.enableDiacriticIgnore = value;
                    // 互斥：如果開啟忽略變音，則關閉布爾查詢
                    if (value && this.plugin.settings.enableBooleanQuery) {
                        this.plugin.settings.enableBooleanQuery = false;
                    }
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // 默認文件模式設置
        searchPanel.createEl("h3", { text: "默認搜索範圍（初始預定範圍）", attr: { style: "margin-top: 20px;" } });
        searchPanel.createEl("p", { 
            text: "每行一個正則表達式，用於匹配文件名或路徑。\"預定範圍\"和\"快速預設範圍搜索\"將使用這些模式。",
            attr: { style: "font-size: 12px; color: var(--text-muted); margin-bottom: 10px;" }
        });

        const patternsTextarea = searchPanel.createEl("textarea", {
            attr: {
                style: "width: 100%; min-height: 200px; font-family: monospace; font-size: 12px; padding: 8px;"
            }
        });

        // 直接使用 settings 中的值，因為 DEFAULT_SETTINGS 已經提供了初始值
        patternsTextarea.value = this.plugin.settings.defaultFilePatterns.join('\n');
        
        const savePatternsBtn = searchPanel.createEl("button", {
            text: "保存為初始預定範圍",
            attr: { style: "margin-top: 10px; margin-bottom: 20px; padding: 6px 16px;" }
        });
        savePatternsBtn.onclick = async () => {
            const lines = patternsTextarea.value.split(/\r?\n/);
            const validPatterns = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    try {
                        new RegExp(trimmed);
                        validPatterns.push(trimmed);
                    } catch (e) {
                        new Notice(`⚠️ 正則錯誤: ${trimmed}`);
                    }
                }
            }
            if (validPatterns.length > 0) {
                this.plugin.settings.defaultFilePatterns = validPatterns;
                await this.plugin.saveSettings();
                // 重新加載 filePatterns
                this.plugin.filePatterns = validPatterns.map(p => new RegExp(p));
                this.plugin.patternStrings = this.plugin.filePatterns.map(p => p.source);
                new Notice(`已保存 ${validPatterns.length} 個模式`);
            } else {
                new Notice("請至少輸入一個有效的正則表達式");
            }
        };

        // ===== 字符寬度設置 =====
        searchPanel.createEl("h3", { text: "字符寬度自定義設置", attr: { style: "margin-top: 20px; margin-bottom: 10px;" } });
        searchPanel.createEl("p", { 
            text: "用於單行模式（A模式）的字符寬度計算。（每行一個，支持單個碼位或 起始-結束）",
            attr: { style: "font-size: 11px; color: var(--text-muted); margin-bottom: 10px;" } 
        });
        
        // 確保 charWidth 對象存在
        if (!this.plugin.settings.charWidth) {
            this.plugin.settings.charWidth = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.charWidth));
        }

        // 雙欄並排容器
        const charsDoubleColumn = searchPanel.createEl("div", {
            attr: { style: "display: flex; gap: 16px; margin-bottom: 16px;" }
        });

        // 左欄：窄字符範圍設置
        const compensatedSection = charsDoubleColumn.createEl("div", {
            attr: { style: "flex: 1; border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 12px;" }
        });
        compensatedSection.createEl("div", {
            text: "📏 窄字符（每個字符折算0.2單位）",
            attr: { style: "font-weight: 600; margin-bottom: 6px;" }
        });
        const compensatedTextarea = compensatedSection.createEl("textarea", {
            attr: {
                style: "width: 100%; min-height: 200px; font-family: monospace; font-size: 12px;",
            }
        });
        compensatedTextarea.value = this.plugin.settings.charWidth.compensatedRanges.join('\n');

        // 右欄：零寬度字符範圍設置
        const zeroWidthSection = charsDoubleColumn.createEl("div", {
            attr: { style: "flex: 1; border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 12px;" }
        });
        zeroWidthSection.createEl("div", {
            text: "⬚ 零寬度字符（不計寬度）",
            attr: { style: "font-weight: 600; margin-bottom: 6px;" }
        });
        const zeroWidthTextarea = zeroWidthSection.createEl("textarea", {
            attr: {
                style: "width: 100%; min-height: 200px; font-family: monospace; font-size: 12px;",
            }
        });
        zeroWidthTextarea.value = this.plugin.settings.charWidth.zeroWidthRanges.join('\n');
        
        // 按鈕容器（並排）
        const buttonContainer = searchPanel.createEl("div", {
            attr: { style: "display: flex; gap: 8px; margin-top: 8px;" }
        });
        
        // 保存字符設置按鈕
        const saveCharsBtn = buttonContainer.createEl("button", {
            text: "💾 保存字符設置",
            attr: { style: "padding: 4px 12px; cursor: pointer;" }
        });
        
        // 重置為默認字符設置按鈕
        const resetCharsBtn = buttonContainer.createEl("button", {
            text: "🔄 重置為默認字符設置",
            attr: { style: "padding: 4px 12px; cursor: pointer;" }
        });
        
        // 保存字符設置事件（同時保存窄字符和零寬度）
        saveCharsBtn.onclick = async () => {
            // 驗證並保存窄字符範圍
            const compensatedLines = compensatedTextarea.value.split(/\r?\n/);
            const validCompensatedRanges = [];
            for (const line of compensatedLines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    if (/^0x[0-9A-Fa-f]+(-0x[0-9A-Fa-f]+)?$/.test(trimmed)) {
                        validCompensatedRanges.push(trimmed);
                    } else {
                        new Notice(`⚠️ 窄字符格式錯誤: ${trimmed}`);
                        return;
                    }
                }
            }
            
            // 驗證並保存零寬度範圍
            const zeroWidthLines = zeroWidthTextarea.value.split(/\r?\n/);
            const validZeroWidthRanges = [];
            for (const line of zeroWidthLines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    if (/^0x[0-9A-Fa-f]+(-0x[0-9A-Fa-f]+)?$/.test(trimmed)) {
                        validZeroWidthRanges.push(trimmed);
                    } else {
                        new Notice(`⚠️ 零寬度格式錯誤: ${trimmed}`);
                        return;
                    }
                }
            }
            
            if (validCompensatedRanges.length === 0 && validZeroWidthRanges.length === 0) {
                new Notice("請至少輸入一個有效的範圍");
                return;
            }
            
            this.plugin.settings.charWidth.compensatedRanges = validCompensatedRanges;
            this.plugin.settings.charWidth.zeroWidthRanges = validZeroWidthRanges;
            await this.plugin.saveSettings();
            
            // 刷新字符寬度緩存
            this.plugin.refreshCharWidthCache();
            
            // 刷新已打開的搜索結果視圖
            const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH_RESULT)[0]?.view;
            if (view && view.currentResults.length > 0) {
                view.refreshDisplay();
            }
            
            new Notice(`已保存 ${validCompensatedRanges.length} 個窄字符範圍，${validZeroWidthRanges.length} 個零寬度範圍`);
        };
        
        // 重置為默認字符設置事件
        resetCharsBtn.onclick = async () => {
            this.plugin.settings.charWidth = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.charWidth));
            await this.plugin.saveSettings();
            
            // 更新文本框顯示
            compensatedTextarea.value = this.plugin.settings.charWidth.compensatedRanges.join('\n');
            zeroWidthTextarea.value = this.plugin.settings.charWidth.zeroWidthRanges.join('\n');
            
            // 刷新字符寬度緩存
            this.plugin.refreshCharWidthCache();
            
            // 刷新已打開的搜索結果視圖
            const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH_RESULT)[0]?.view;
            if (view && view.currentResults.length > 0) {
                view.refreshDisplay();
            }
            
            new Notice("已重置字符寬度設置為默認值");
        };

        // ==================== 選項卡2：優先級設置 ====================
        const priorityPanel = panels.priority;
        
        // 排序開關
        new Setting(priorityPanel)
            .setName("啟用結果排序")
            .setDesc("啟用後，搜索結果將按照下面的規則排序（文件優先級 > 文件組間優先級 > 文件組內模式優先級 > 默認順序）")
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableSorting)
                .onChange(async (value) => {
                    this.plugin.settings.enableSorting = value;
                    await this.plugin.saveSettings();
                }));
        
        // 1. 文件優先級
        priorityPanel.createEl("h4", { text: "1️⃣ 文件優先級（每行一個正則）", attr: { style: "margin-top: 16px; margin-bottom: 8px;" } });
        priorityPanel.createEl("p", { 
            text: "設置優先文件/路徑的正則表達式。匹配到的文件會優先顯示（按行順序，越靠前優先級越高）。支持用 # 開頭寫註釋。",
            attr: { style: "font-size: 11px; color: var(--text-muted); margin-bottom: 8px;" }
        });
        
        const filePriorityTextarea = priorityPanel.createEl("textarea", {
            attr: {
                style: "width: 100%; min-height: 120px; font-family: monospace; font-size: 12px; padding: 8px; margin-bottom: 8px;"
            }
        });
        // 將數組轉為多行字符串顯示
        const filePriorityArray = this.plugin.settings.filePriority || [];
        filePriorityTextarea.value = Array.isArray(filePriorityArray) ? filePriorityArray.join('\n') : "";
        filePriorityTextarea.placeholder = `# 示例：優先顯示路徑包含 "重要" 的文件
.*重要.*
^kosa\\/ju\\/
# 優先顯示特定文件名
筆記\\d+\\.md`;
        
        const saveFilePriorityBtn = priorityPanel.createEl("button", {
            text: "保存文件優先級",
            attr: { style: "margin-bottom: 20px; padding: 4px 12px;" }
        });
        saveFilePriorityBtn.onclick = async () => {
            const lines = filePriorityTextarea.value.split(/\r?\n/);
            const validPatterns = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    // 驗證正則有效性
                    try {
                        new RegExp(trimmed);
                        validPatterns.push(trimmed);
                    } catch (e) {
                        new Notice(`⚠️ 正則錯誤: ${trimmed}`);
                    }
                }
            }
            this.plugin.settings.filePriority = validPatterns;
            await this.plugin.saveSettings();
            new Notice(`已保存 ${validPatterns.length} 個文件優先級模式`);
        };

        // 2. 文件組間優先級
        priorityPanel.createEl("h4", { text: "2️⃣ 文件組間優先級", attr: { style: "margin-top: 16px; margin-bottom: 8px;" } });
        priorityPanel.createEl("p", { 
            text: "設置文件組的顯示優先順序。拖動左側按鈕調整順序，越靠上優先級越高。如果同一文件屬於多個組，歸入優先級最高的組。",
            attr: { style: "font-size: 11px; color: var(--text-muted); margin-bottom: 8px;" }
        });

        const groupPriorityContainer = priorityPanel.createEl("div", {
            attr: { style: "border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 8px; margin-bottom: 20px; background: var(--background-primary);" }
        });
        
        const refreshGroupPriority = () => {
            const groups = this.plugin.settings.fileGroups?.groups || {};
            const groupNames = Object.keys(groups);
            const currentPriority = this.plugin.settings.groupPriority || [];
            
            // 合併：已有的優先級 + 新的組（放在末尾）
            const allGroups = [...new Set([...currentPriority, ...groupNames])];
            const finalPriority = allGroups.filter(name => groupNames.includes(name));
            
            groupPriorityContainer.empty();
            
            if (finalPriority.length === 0) {
                groupPriorityContainer.createEl("div", {
                    text: "暫無文件組。請先在「管理文件組/組合」中創建文件組。",
                    attr: { style: "text-align: center; color: var(--text-muted); padding: 16px;" }
                });
                return;
            }
            
            const listEl = groupPriorityContainer.createEl("div", {
                attr: { style: "display: flex; flex-direction: column; gap: 4px;" }
            });
            
            finalPriority.forEach((groupName, idx) => {
                // 文件組間沒有排除行概念，所有項都可拖拽
                const displayText = `${idx + 1}. ${groupName}`;
                
                const row = this.createDraggableRow(
                    listEl,                    // 容器
                    finalPriority,             // 數據數組
                    idx,                       // 當前索引
                    (fromIndex, toIndex) => {  // 排序回調
                        const temp = finalPriority[fromIndex];
                        finalPriority[fromIndex] = finalPriority[toIndex];
                        finalPriority[toIndex] = temp;
                        this.plugin.settings.groupPriority = finalPriority;
                        this.plugin.saveSettings();
                        refreshGroupPriority();
                    },
                    true,                      // 可拖拽
                    displayText,               // 顯示文字
                    ""                         // 無額外樣式
                );
            });
        };
        
        refreshGroupPriority();

        // 3. 文件組內模式優先級
        priorityPanel.createEl("h4", { text: "3️⃣ 文件組內模式優先級", attr: { style: "margin-top: 16px; margin-bottom: 8px;" } });
        priorityPanel.createEl("p", { 
            text: "設置每個文件組內正則模式的優先順序。拖動左側按鈕調整順序，越靠上優先級越高。",
            attr: { style: "font-size: 11px; color: var(--text-muted); margin-bottom: 8px;" }
        });
        
        const groupPatternOrderContainer = priorityPanel.createEl("div", {
            attr: { style: "margin-bottom: 20px;" }
        });

        const refreshGroupPatternOrder = () => {
            const groups = this.plugin.settings.fileGroups?.groups || {};
            const groupNames = Object.keys(groups);
            const currentOrder = this.plugin.settings.groupPatternOrder || {};
            
            groupPatternOrderContainer.empty();
            
            if (groupNames.length === 0) {
                groupPatternOrderContainer.createEl("div", {
                    text: "暫無文件組。請先在「管理文件組/組合」中創建文件組。",
                    attr: { style: "text-align: center; color: var(--text-muted); padding: 16px;" }
                });
                return;
            }

            for (const groupName of groupNames) {
                const groupCard = groupPatternOrderContainer.createEl("div", {
                    attr: { style: "border: 1px solid var(--background-modifier-border); border-radius: 8px; margin-bottom: 12px; overflow: hidden;" }
                });
                
                const header = groupCard.createEl("div", {
                    attr: { style: "background: var(--background-secondary); padding: 8px 12px; font-weight: 600; font-size: 13px; cursor: pointer;" }
                });
                const toggleIcon = header.createEl("span", { text: "▶" });
                header.createEl("span", { text: ` 📂 ${groupName}`, attr: { style: "margin-left: 8px;" } });
                
                const content = groupCard.createEl("div", {
                    attr: { style: "padding: 12px; display: none;" }
                });
                
                let isExpanded = false;
                header.onclick = () => {
                    isExpanded = !isExpanded;
                    content.style.display = isExpanded ? "block" : "none";
                    toggleIcon.textContent = isExpanded ? "▼" : "▶";
                    if (isExpanded) {
                        refreshPatternList();
                    }
                };
                
                const patternListContainer = content.createEl("div", {
                    attr: { style: "display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;" }
                });
                
                const refreshPatternList = () => {
                    const groupData = groups[groupName];
                    const patterns = groupData?.patterns || [];
                    const groupOrder = currentOrder[groupName] || {};
                    
                    // 獲取排序後的模式列表
                    let sortedPatterns = [...patterns];
                    sortedPatterns.sort((a, b) => {
                        const orderA = groupOrder[a] !== undefined ? groupOrder[a] : Infinity;
                        const orderB = groupOrder[b] !== undefined ? groupOrder[b] : Infinity;
                        if (orderA !== orderB) return orderA - orderB;
                        return patterns.indexOf(a) - patterns.indexOf(b);
                    });
                    
                    patternListContainer.empty();
                    
                    if (patterns.length === 0) {
                        patternListContainer.createEl("div", {
                            text: "該文件組暫無模式",
                            attr: { style: "text-align: center; color: var(--text-muted); padding: 12px;" }
                        });
                        return;
                    }

                    sortedPatterns.forEach((pattern, idx) => {
                        // 檢查是否為排除行
                        const isExclude = pattern.trim().startsWith('!') && !pattern.trim().startsWith('\\!');
                        const displayPattern = isExclude ? '🚫 ' + pattern : pattern;
                        const patternPreview = displayPattern.length > 60 ? displayPattern.substring(0, 57) + "..." : displayPattern;
                        const displayText = `${idx + 1}. ${patternPreview}`;
                        const displayStyle = isExclude ? 'opacity: 0.7; font-family: monospace; font-size: 11px;' : 'font-family: monospace; font-size: 11px;';
                        
                        const row = this.createDraggableRow(
                            patternListContainer,      // 容器
                            sortedPatterns,            // 數據數組
                            idx,                       // 當前索引
                            (fromIndex, toIndex) => {  // 排序回調
                                const temp = sortedPatterns[fromIndex];
                                sortedPatterns[fromIndex] = sortedPatterns[toIndex];
                                sortedPatterns[toIndex] = temp;
                                // 更新順序映射
                                const newOrder = {};
                                sortedPatterns.forEach((p, i) => {
                                    newOrder[p] = i;
                                });
                                this.plugin.settings.groupPatternOrder[groupName] = newOrder;
                                this.plugin.saveSettings();
                                refreshPatternList();
                            },
                            !isExclude,                // 可拖拽（排除行不可拖拽）
                            displayText,               // 顯示文字
                            displayStyle               // 樣式
                        );
                    });
                };

                const resetBtn = content.createEl("button", {
                    text: "重置該組順序（恢復為默認順序）",
                    attr: { style: "padding: 4px 8px; font-size: 11px; margin-top: 8px;" }
                });
                resetBtn.onclick = () => {
                    delete this.plugin.settings.groupPatternOrder[groupName];
                    this.plugin.saveSettings();
                    refreshPatternList();
                    new Notice(`已重置「${groupName}」的模式順序`);
                };
            }
        };
        
        refreshGroupPatternOrder();

        // 重置、保存排序設置
        const sortingButtonsRow = priorityPanel.createEl("div", {
            attr: { style: "display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;" }
        });
        
        // 保存排序設置按鈕
        const saveSortingBtn = sortingButtonsRow.createEl("button", {
            text: "💾 保存排序設置到文件組",
            attr: { style: "padding: 6px 16px; background: var(--interactive-accent); color: white; border: none; border-radius: 6px; cursor: pointer;" }
        });
        
        // 重置所有排序設置按鈕
        const resetSortingBtn = sortingButtonsRow.createEl("button", {
            text: "🔄 重置所有排序設置",
            attr: { style: "padding: 6px 16px; background: var(--background-modifier-error); color: white; border: none; border-radius: 6px; cursor: pointer;" }
        });

        const manageGroupsBtn = sortingButtonsRow.createEl("button", {
            text: "📁 管理文件組/組合",
            attr: { style: "padding: 6px 16px; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; cursor: pointer;" }
        });

        manageGroupsBtn.onclick = async () => {
            this.app.setting.close();
            await this.plugin.showCustomFileGroupsDialog("");
        };

        saveSortingBtn.onclick = async () => {
            const groups = this.plugin.settings.fileGroups?.groups || {};
            const groupPriority = this.plugin.settings.groupPriority || [];
            const groupPatternOrder = this.plugin.settings.groupPatternOrder || {};
            
            // 1. 保存文件組間順序：根據 groupPriority 重建 groups 對象
            if (groupPriority.length > 0) {
                const newGroups = {};
                // 先按優先級順序添加現有的組
                for (const groupName of groupPriority) {
                    if (groups[groupName]) {
                        newGroups[groupName] = groups[groupName];
                    }
                }
                // 補上可能遺漏的組（新創建但還沒在優先級列表中的）
                for (const [name, group] of Object.entries(groups)) {
                    if (!newGroups[name]) {
                        newGroups[name] = group;
                    }
                }
                this.plugin.settings.fileGroups.groups = newGroups;
            }
            
            // 2. 保存文件組內模式順序：根據 groupPatternOrder 重新排列每個組的 patterns 數組
            for (const [groupName, orderMap] of Object.entries(groupPatternOrder)) {
                const group = this.plugin.settings.fileGroups.groups[groupName];
                if (group && group.patterns) {
                    const sortedPatterns = [...group.patterns];
                    sortedPatterns.sort((a, b) => {
                        const orderA = orderMap[a] !== undefined ? orderMap[a] : Infinity;
                        const orderB = orderMap[b] !== undefined ? orderMap[b] : Infinity;
                        if (orderA !== orderB) return orderA - orderB;
                        return group.patterns.indexOf(a) - group.patterns.indexOf(b);
                    });
                    group.patterns = sortedPatterns;
                }
            }
            
            await this.plugin.saveSettings();
            new Notice("排序設置已保存到文件組中");
            this.display(); // 刷新設置頁面，顯示新的順序
        };

        resetSortingBtn.onclick = async () => {
            // 重置排序設置
            this.plugin.settings.enableSorting = true;
            this.plugin.settings.filePriority = [];
            this.plugin.settings.groupPriority = [];
            this.plugin.settings.groupPatternOrder = {};
            // 注意：這裡不改變文件組的初始順序，只是還原為初始順序
            // 「保存排序設置」會把當前的排序規則寫入初始順序
            // 「管理文件組/組合」中也可以手動調整初始順序
            await this.plugin.saveSettings();
            new Notice("已重置所有排序設置（文件組順序未變）");
            this.display();
        };

        // ==================== 選項卡3：歷史管理 ====================
        const historyPanel = panels.history;
        
        const historyContainer = historyPanel.createEl("div", {
            attr: { style: "margin-bottom: 20px; padding: 12px; background: var(--background-secondary); border-radius: 8px;" }
        });
        
        // 最大保存數量設置行
        const maxSizeRow = historyContainer.createEl("div", {
            attr: { style: "display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;" }
        });
        maxSizeRow.createEl("span", {
            text: "📊 最大保存歷史數：",
            attr: { style: "font-size: 13px;" }
        });
        
        const maxSizeInput = maxSizeRow.createEl("input", {
            type: "number",
            attr: {
                min: 1,
                max: 100,
                step: 1,
                value: this.plugin.settings.maxHistorySize || 10,
                style: "width: 80px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary);"
            }
        });
        
        maxSizeInput.onchange = async () => {
            let newSize = parseInt(maxSizeInput.value);
            if (isNaN(newSize) || newSize < 1) newSize = 1;
            if (newSize > 100) newSize = 100;
            
            this.plugin.settings.maxHistorySize = newSize;
            
            // 如果新的大小小於當前歷史數量，截斷歷史
            if (this.plugin.settings.searchHistory.items.length > newSize) {
                this.plugin.settings.searchHistory.items = this.plugin.settings.searchHistory.items.slice(0, newSize);
                if (this.plugin.settings.searchHistory.currentIndex >= newSize) {
                    this.plugin.settings.searchHistory.currentIndex = newSize - 1;
                }
                new Notice(`歷史已截斷為 ${newSize} 條`);
            }
            
            await this.plugin.saveSettings();
            
            // 更新顯示的當前數量
            const historyCountSpan = historyInfo.querySelector('.history-count-span');
            if (historyCountSpan) {
                const newCount = this.plugin.settings.searchHistory.items.length;
                historyCountSpan.textContent = `${newCount}/${newSize}`;
            }
        };

        // 面板寬度設置行
        const panelWidthRow = historyContainer.createEl("div", {
            attr: { style: "display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;" }
        });
        panelWidthRow.createEl("span", {
            text: "📐 歷史面板寬度：",
            attr: { style: "font-size: 13px;" }
        });
        
        const panelWidthInput = panelWidthRow.createEl("input", {
            type: "number",
            attr: {
                min: 200,
                max: 600,
                step: 10,
                value: this.plugin.settings.historyPanelWidth || 256,
                style: "width: 80px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary);"
            }
        });
        panelWidthInput.createEl("span", { text: " px", attr: { style: "margin-left: 4px; font-size: 12px;" } });
        
        panelWidthInput.onchange = async () => {
            let newWidth = parseInt(panelWidthInput.value);
            if (isNaN(newWidth) || newWidth < 200) newWidth = 200;
            if (newWidth > 600) newWidth = 600;
            
            this.plugin.settings.historyPanelWidth = newWidth;
            await this.plugin.saveSettings();
            new Notice(`面板寬度已設為 ${newWidth}px，下次打開生效`);
        };

        const historyInfo = historyContainer.createEl("div", {
            attr: { style: "display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 8px;" }
        });
        
        const maxSize = this.plugin.settings.maxHistorySize || 10;
        const historyCount = this.plugin.settings.searchHistory?.items?.length || 0;
        const countSpan = historyInfo.createEl("span", {
            attr: { style: "font-size: 13px; color: var(--text-muted);" }
        });
        countSpan.innerHTML = `📊 當前保存 <span class="history-count-span">${historyCount}/${maxSize}</span> 條搜索歷史`;
        
        const clearHistoryBtn = historyInfo.createEl("button", {
            text: "🗑️ 清除所有歷史",
            attr: { style: "padding: 4px 12px; background: var(--background-modifier-error); color: white; border: none; border-radius: 6px; cursor: pointer;" }
        });
        clearHistoryBtn.onclick = async () => {
            if (this.plugin.settings.searchHistory) {
                this.plugin.settings.searchHistory.items = [];
                this.plugin.settings.searchHistory.currentIndex = -1;
                await this.plugin.saveSettings();
                new Notice("已清除所有搜索歷史");
                this.display(); // 刷新設置頁面
            }
        };

        // 顯示歷史列表（用於調試和手動刪除）
        if (historyCount > 0) {
            const historyList = historyContainer.createEl("div", {
                attr: { style: "margin-top: 12px; max-height: 200px; overflow-y: auto; border-top: 1px solid var(--background-modifier-border); padding-top: 8px;" }
            });
            
            const items = this.plugin.settings.searchHistory.items;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const row = historyList.createEl("div", {
                    attr: { style: "display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--background-modifier-border); font-size: 12px;" }
                });
                
                const displayText = `${item.searchText.length > 40 ? item.searchText.substring(0, 37) + "..." : item.searchText} | ${item.rangeDisplay || (item.isPreset ? "預設範圍" : "自定義範圍")}`;
                row.createEl("span", { text: displayText, attr: { style: "font-family: monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" } });
                
                const deleteBtn = row.createEl("button", {
                    text: "刪除",
                    attr: { style: "padding: 2px 8px; font-size: 10px; margin-left: 8px; cursor: pointer;" }
                });
                deleteBtn.onclick = async () => {
                    items.splice(i, 1);
                    if (this.plugin.settings.searchHistory.currentIndex >= items.length) {
                        this.plugin.settings.searchHistory.currentIndex = items.length - 1;
                    }
                    await this.plugin.saveSettings();
                    new Notice("已刪除該歷史記錄");
                    this.display(); // 刷新設置頁面
                };
            }
        }

        // ==================== 選項卡4：顏色外觀 ====================
        const colorsPanel = panels.colors;

        // 確保 colors 對象存在
        if (!this.plugin.settings.colors) {
            this.plugin.settings.colors = DEFAULT_SETTINGS.colors;
        }

        // 輔助函數：創建帶透明度的顏色選擇器
        const createColorWithOpacity = (name, key, description) => {
            const setting = new Setting(colorsPanel)
                .setName(name)
                .setDesc(description);
            
            const controlDiv = setting.controlEl.createDiv({ 
                attr: { style: "display: flex; gap: 10px; align-items: center; flex-wrap: wrap;" } 
            });
            
            // 顏色選擇器
            const colorInput = controlDiv.createEl("input", {
                type: "color",
                attr: { style: "width: 60px; height: 32px; cursor: pointer; border: 1px solid var(--background-modifier-border); border-radius: 4px;" }
            });
        
            // 透明度滑塊
            const opacitySlider = controlDiv.createEl("input", {
                type: "range",
                attr: { min: 0, max: 1, step: 0.01, style: "width: 100px; cursor: pointer;" }
            });
            
            // 透明度百分比顯示
            const opacityPercent = controlDiv.createEl("span", {
                attr: { style: "font-size: 12px; font-family: monospace; min-width: 45px;" }
            });
            
            // 實時預覽色塊
            const previewBlock = controlDiv.createEl("div", {
                attr: { 
                    style: "width: 40px; height: 32px; border-radius: 4px; border: 1px solid var(--background-modifier-border);"
                }
            });
            
            // 顏色值輸入框（可手動修改）
            const valueInput = controlDiv.createEl("input", {
                type: "text",
                attr: { 
                    style: "width: 180px; font-size: 11px; padding: 4px 6px; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 4px; font-family: monospace;",
                    placeholder: "rgba(r, g, b, a) 或 #RRGGBB"
                }
            });
            
            // 從 rgba 字符串解析顏色
            const parseRgbaString = (str) => {
                // 匹配 rgba(r, g, b, a) 格式
                let match = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
                if (match) {
                    return {
                        r: parseInt(match[1]),
                        g: parseInt(match[2]),
                        b: parseInt(match[3]),
                        a: match[4] ? parseFloat(match[4]) : 1
                    };
                }
                // 匹配十六進制格式 #RRGGBB 或 #RGB
                match = str.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
                if (match) {
                    return {
                        r: parseInt(match[1], 16),
                        g: parseInt(match[2], 16),
                        b: parseInt(match[3], 16),
                        a: 1
                    };
                }
                match = str.match(/^#?([a-f\d])([a-f\d])([a-f\d])$/i);
                if (match) {
                    return {
                        r: parseInt(match[1] + match[1], 16),
                        g: parseInt(match[2] + match[2], 16),
                        b: parseInt(match[3] + match[3], 16),
                        a: 1
                    };
                }
                return null;
            };

            // 獲取默認顏色值的函數
            const getDefaultColor = (colorKey) => {
                return DEFAULT_SETTINGS.colors[colorKey] || "rgba(128, 106, 106, 0.78)";
            };

            // 更新所有 UI 組件
            const updateAll = (r, g, b, a) => {
                const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
                const rgba = `rgba(${r}, ${g}, ${b}, ${a})`;
                
                colorInput.value = hex;
                opacitySlider.value = a;
                opacityPercent.textContent = `${Math.round(a * 100)}%`;
                valueInput.value = rgba;
                previewBlock.style.backgroundColor = rgba;
                
                this.plugin.settings.colors[key] = rgba;
                this.plugin.saveSettings();
                
                // 實時刷新搜索結果視圖
                const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH_RESULT)[0]?.view;
                if (view && view.currentResults.length > 0) {
                    view.refreshDisplay();
                }
            };
            
            // 解析當前顏色值
            const parseCurrent = () => {
                let currentValue = this.plugin.settings.colors?.[key];
                if (!currentValue) {
                    currentValue = getDefaultColor(key);
                }
                const parsed = parseRgbaString(currentValue);
                if (parsed) {
                    updateAll(parsed.r, parsed.g, parsed.b, parsed.a);
                } else {
                    // 默認值
                    updateAll(128, 106, 106, 0.78);
                }
            };
            
            // 顏色選擇器變化
            colorInput.onchange = () => {
                const hex = colorInput.value;
                const r = parseInt(hex.slice(1,3), 16);
                const g = parseInt(hex.slice(3,5), 16);
                const b = parseInt(hex.slice(5,7), 16);
                const a = parseFloat(opacitySlider.value);
                updateAll(r, g, b, a);
            };
            
            // 透明度滑塊變化
            opacitySlider.oninput = () => {
                const hex = colorInput.value;
                const r = parseInt(hex.slice(1,3), 16);
                const g = parseInt(hex.slice(3,5), 16);
                const b = parseInt(hex.slice(5,7), 16);
                const a = parseFloat(opacitySlider.value);
                updateAll(r, g, b, a);
            };
            
            // 手動輸入框變化
            valueInput.onchange = () => {
                const parsed = parseRgbaString(valueInput.value);
                if (parsed) {
                    updateAll(parsed.r, parsed.g, parsed.b, parsed.a);
                } else {
                    new Notice(`無效的顏色格式: ${valueInput.value}`);
                    // 恢復原值
                    parseCurrent();
                }
            };
            
            parseCurrent();
        };

        // 用分隔線簡單分組
        colorsPanel.createEl("h3", { text: "搜索結果顏色", attr: { style: "margin-top: 0px;" } });
        colorsPanel.createEl("h4", { text: "——— 基礎顏色 ———", attr: { style: "margin-top: 10px; margin-bottom: 10px; color: var(--text-muted);" } });

        createColorWithOpacity("文件名顏色", "fileName", "設置搜索結果中文件名的顏色");
        createColorWithOpacity("匹配行背景色", "matchLineBg", "設置匹配行的背景顏色");
        createColorWithOpacity("關鍵詞高亮背景色", "keywordBg", "設置搜索關鍵詞的高亮背景顏色");
        createColorWithOpacity("懸停背景色", "hoverBg", "鼠標懸停時的行背景顏色");
        
        colorsPanel.createEl("h4", { text: "——— 模式按鈕顏色 ———", attr: { style: "margin-top: 10px; margin-bottom: 10px; color: var(--text-muted);" } });
        
        createColorWithOpacity("模式 A 按鈕顏色", "modeA", "單行模式的按鈕顏色");
        createColorWithOpacity("模式 B 按鈕顏色", "modeB", "3行滾動模式的按鈕顏色");
        createColorWithOpacity("模式 C 按鈕顏色", "modeC", "展開模式的按鈕顏色");
        createColorWithOpacity("激活模式外框顏色", "activeBorder", "當前激活的全局模式按鈕的外框顏色");
        
        colorsPanel.createEl("h4", { text: "——— 序號文字顏色 ———", attr: { style: "margin-top: 10px; margin-bottom: 10px; color: var(--text-muted);" } });
        
        createColorWithOpacity("A模式序號文字顏色", "modeANumberColor", "A模式（單行模式）序號數字的文字顏色");
        createColorWithOpacity("B模式序號文字顏色", "modeBNumberColor", "B模式（3行滾動）序號數字的文字顏色");
        createColorWithOpacity("C模式序號文字顏色", "modeCNumberColor", "C模式（展開模式）序號數字的文字顏色");

        // 重置按鈕
        const resetColorsBtn = colorsPanel.createEl("button", {
            text: "重置所有顏色為默認值",
            attr: { style: "margin-top: 10px; margin-bottom: 20px; padding: 6px 16px;" }
        });
        resetColorsBtn.onclick = async () => {
            this.plugin.settings.colors = { ...DEFAULT_SETTINGS.colors };
            await this.plugin.saveSettings();
            new Notice("顏色已重置為默認值");
            this.display(); // 刷新設置頁面
        };

        // ==================== 選項卡5：說明 ====================
        const helpPanel = panels.help;
        
        // 命令列表
        helpPanel.createEl("h3", { text: "可用命令", attr: { style: "margin-top: 0px;" } });

        const commandList = [
            { name: "搜索面板", hasContextMenu: true, description: "打開搜索模式對話框" },
            { name: "快速預設範圍搜索", hasContextMenu: true, description: "選中文本後，使用默認範圍快速搜索" },
            { name: "打開結果面板", hasContextMenu: false, description: "打開或聚焦搜索結果側邊欄" },
            { name: "管理文件組/組合", hasContextMenu: false, description: "管理自定義的文件組和組合" }
        ];

        const commandTable = helpPanel.createEl("div", {
            attr: { style: "margin-top: 10px; border: 1px solid var(--background-modifier-border); border-radius: 8px; overflow: hidden;" }
        });

        for (const cmd of commandList) {
            const row = commandTable.createEl("div", {
                attr: { style: "display: flex; padding: 10px 12px; border-bottom: 1px solid var(--background-modifier-border);" }
            });
            
            // 命令名稱
            const nameCol = row.createEl("div", {
                attr: { style: "width: 35%; font-weight: 600;" }
            });
            nameCol.createEl("span", { text: cmd.name });
            
            // 只有前兩項才顯示「右鍵菜單」標籤
            if (cmd.hasContextMenu) {
                nameCol.createEl("span", { 
                    text: " (右鍵菜單)", 
                    attr: { style: "font-size: 10px; color: var(--text-accent); margin-left: 6px; font-weight: normal;" }
                });
            }

            // 描述
            row.createEl("div", {
                text: cmd.description,
                attr: { style: "width: 65%; color: var(--text-muted); font-size: 12px;" }
            });
        }

        // 最後一行沒有底部邊框
        const lastRow = commandTable.children[commandTable.children.length - 1];
        if (lastRow) {
            lastRow.style.borderBottom = "none";
        }

        // 正則提示
        const helpEl = helpPanel.createEl("div", {
            attr: { style: "margin-top: 20px; padding: 10px; background: var(--background-secondary); border-radius: 6px; font-size: 12px;" }
        });
        helpEl.innerHTML = `
            <strong>📖 正則表達式提示：</strong><br>
            • 純文件名匹配：<code>(books|mynotes)[\\d-]+\\.md</code><br>
            • 路徑匹配（包含 / ）：<code>^kosa\\/ju\\/</code><br>
            • 註釋行以 # 開頭<br>
            • 修改後需要重新啟動插件或重新搜索才能生效
        `;

        // GitHub 鏈接
        const githubLink = helpPanel.createEl("div", {
            attr: { style: "margin-top: 20px; padding: 10px; text-align: center; border-top: 1px solid var(--background-modifier-border);" }
        });
        githubLink.createEl("a", {
            text: "📦 GitHub 地址",
            attr: {
                href: "https://github.com/arpcn/obsidian-custom-search",
                target: "_blank",
                style: "color: var(--text-accent); text-decoration: none; font-size: 12px;"
            }
        });

    }
}

module.exports = CustomSearchPlugin;

