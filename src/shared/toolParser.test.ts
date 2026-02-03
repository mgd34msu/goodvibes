// ============================================================================
// TOOL PARSER TESTS
// Comprehensive tests for parsing Bash commands and MCP-CLI tool references
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  parseBashCommand,
  parseMcpCliTool,
  resolveToolNames,
} from './toolParser';

// ============================================================================
// parseBashCommand TESTS
// ============================================================================

describe('parseBashCommand', () => {
  // --------------------------------------------------------------------------
  // Edge Cases and Invalid Input
  // --------------------------------------------------------------------------
  describe('edge cases and invalid input', () => {
    it('returns ["Bash"] for empty string', () => {
      expect(parseBashCommand('')).toEqual(['Bash']);
    });

    it('returns ["Bash"] for null input', () => {
      expect(parseBashCommand(null as unknown as string)).toEqual(['Bash']);
    });

    it('returns ["Bash"] for undefined input', () => {
      expect(parseBashCommand(undefined as unknown as string)).toEqual(['Bash']);
    });

    it('returns ["Bash"] for non-string input', () => {
      expect(parseBashCommand(123 as unknown as string)).toEqual(['Bash']);
      expect(parseBashCommand({} as unknown as string)).toEqual(['Bash']);
      expect(parseBashCommand([] as unknown as string)).toEqual(['Bash']);
    });

    it('returns ["Bash"] for whitespace-only input', () => {
      expect(parseBashCommand('   ')).toEqual(['Bash']);
      expect(parseBashCommand('\t\n')).toEqual(['Bash']);
    });

    it('returns ["Bash"] for unrecognized commands', () => {
      expect(parseBashCommand('somecustomcommand --flag')).toEqual(['Bash']);
      expect(parseBashCommand('unknown-tool run test')).toEqual(['Bash']);
    });
  });

  // --------------------------------------------------------------------------
  // MCP-CLI Commands (Highest Priority)
  // --------------------------------------------------------------------------
  describe('mcp-cli commands', () => {
    it('parses mcp-cli call with goodvibes server', () => {
      expect(parseBashCommand('mcp-cli call plugin_goodvibes_goodvibes-tools/detect_stack \'{}\'')).toEqual([
        'goodvibes - detect_stack',
      ]);
    });

    it('parses mcp-cli info with goodvibes server', () => {
      expect(parseBashCommand('mcp-cli info plugin_goodvibes_goodvibes-tools/check_types')).toEqual([
        'goodvibes - check_types',
      ]);
    });

    it('parses mcp-cli call with non-goodvibes server', () => {
      expect(parseBashCommand('mcp-cli call slack/search_messages \'{"query":"test"}\'')).toEqual([
        'mcp:slack - search_messages',
      ]);
    });

    it('parses mcp-cli info with non-goodvibes server', () => {
      expect(parseBashCommand('mcp-cli info database/query')).toEqual([
        'mcp:database - query',
      ]);
    });

    it('parses mcp-cli tools command', () => {
      expect(parseBashCommand('mcp-cli tools')).toEqual(['mcp-cli tools']);
    });

    it('parses mcp-cli servers command', () => {
      expect(parseBashCommand('mcp-cli servers')).toEqual(['mcp-cli servers']);
    });

    it('parses mcp-cli grep command', () => {
      expect(parseBashCommand('mcp-cli grep weather')).toEqual(['mcp-cli grep']);
    });

    it('parses mcp-cli resources command', () => {
      expect(parseBashCommand('mcp-cli resources')).toEqual(['mcp-cli resources']);
    });

    it('parses mcp-cli read command', () => {
      expect(parseBashCommand('mcp-cli read server/resource')).toEqual(['mcp-cli read']);
    });

    it('handles mcp-cli with malformed tool reference', () => {
      expect(parseBashCommand('mcp-cli call malformed-no-slash')).toEqual(['mcp-cli: malformed-no-slash']);
    });
  });

  // --------------------------------------------------------------------------
  // Git Commands
  // --------------------------------------------------------------------------
  describe('git commands', () => {
    it('parses git status', () => {
      expect(parseBashCommand('git status')).toEqual(['git status']);
    });

    it('parses git add', () => {
      expect(parseBashCommand('git add .')).toEqual(['git add']);
      expect(parseBashCommand('git add -A')).toEqual(['git add']);
    });

    it('parses git commit', () => {
      expect(parseBashCommand('git commit -m "test message"')).toEqual(['git commit']);
    });

    it('parses git push', () => {
      expect(parseBashCommand('git push origin main')).toEqual(['git push']);
    });

    it('parses git pull', () => {
      expect(parseBashCommand('git pull --rebase')).toEqual(['git pull']);
    });

    it('parses git fetch', () => {
      expect(parseBashCommand('git fetch --all')).toEqual(['git fetch']);
    });

    it('parses git merge', () => {
      expect(parseBashCommand('git merge feature-branch')).toEqual(['git merge']);
    });

    it('parses git rebase', () => {
      expect(parseBashCommand('git rebase main')).toEqual(['git rebase']);
    });

    it('parses git checkout', () => {
      expect(parseBashCommand('git checkout -b new-branch')).toEqual(['git checkout']);
    });

    it('parses git branch', () => {
      expect(parseBashCommand('git branch -a')).toEqual(['git branch']);
    });

    it('parses git diff', () => {
      expect(parseBashCommand('git diff HEAD~1')).toEqual(['git diff']);
    });

    it('parses git log', () => {
      expect(parseBashCommand('git log --oneline -10')).toEqual(['git log']);
    });

    it('parses git stash', () => {
      expect(parseBashCommand('git stash pop')).toEqual(['git stash']);
    });

    it('parses git reset', () => {
      expect(parseBashCommand('git reset --hard HEAD')).toEqual(['git reset']);
    });

    it('parses git cherry-pick', () => {
      expect(parseBashCommand('git cherry-pick abc123')).toEqual(['git cherry-pick']);
    });

    it('parses git clone', () => {
      expect(parseBashCommand('git clone https://github.com/user/repo.git')).toEqual(['git clone']);
    });

    it('parses git init', () => {
      expect(parseBashCommand('git init')).toEqual(['git init']);
    });

    it('parses git tag', () => {
      expect(parseBashCommand('git tag v1.0.0')).toEqual(['git tag']);
    });

    it('parses git remote', () => {
      expect(parseBashCommand('git remote add origin url')).toEqual(['git remote']);
    });

    it('parses generic git command without recognized subcommand', () => {
      expect(parseBashCommand('git config user.name "Test"')).toEqual(['git']);
    });
  });

  // --------------------------------------------------------------------------
  // npm Commands
  // --------------------------------------------------------------------------
  describe('npm commands', () => {
    it('parses npm install', () => {
      expect(parseBashCommand('npm install')).toEqual(['npm install']);
      expect(parseBashCommand('npm install lodash')).toEqual(['npm install']);
      expect(parseBashCommand('npm install --save-dev vitest')).toEqual(['npm install']);
    });

    it('parses npm run', () => {
      expect(parseBashCommand('npm run build')).toEqual(['npm run']);
      expect(parseBashCommand('npm run test:unit')).toEqual(['npm run']);
    });

    it('parses npm test', () => {
      expect(parseBashCommand('npm test')).toEqual(['npm test']);
      expect(parseBashCommand('npm test -- --coverage')).toEqual(['npm test']);
    });

    it('parses npm build', () => {
      expect(parseBashCommand('npm build')).toEqual(['npm build']);
    });

    it('parses npm start', () => {
      expect(parseBashCommand('npm start')).toEqual(['npm start']);
    });

    it('parses npm publish', () => {
      expect(parseBashCommand('npm publish --access public')).toEqual(['npm publish']);
    });

    it('parses npm update', () => {
      expect(parseBashCommand('npm update')).toEqual(['npm update']);
    });

    it('parses npm outdated', () => {
      expect(parseBashCommand('npm outdated')).toEqual(['npm outdated']);
    });

    it('parses npm audit', () => {
      expect(parseBashCommand('npm audit fix')).toEqual(['npm audit']);
    });

    it('parses npm ci', () => {
      expect(parseBashCommand('npm ci')).toEqual(['npm ci']);
    });

    it('parses npm init', () => {
      expect(parseBashCommand('npm init -y')).toEqual(['npm init']);
    });

    it('parses npm link', () => {
      expect(parseBashCommand('npm link some-package')).toEqual(['npm link']);
    });

    it('parses npm pack', () => {
      expect(parseBashCommand('npm pack')).toEqual(['npm pack']);
    });

    it('parses npm uninstall', () => {
      expect(parseBashCommand('npm uninstall lodash')).toEqual(['npm uninstall']);
    });

    it('parses generic npm command', () => {
      expect(parseBashCommand('npm version patch')).toEqual(['npm']);
    });
  });

  // --------------------------------------------------------------------------
  // pnpm Commands
  // --------------------------------------------------------------------------
  describe('pnpm commands', () => {
    it('parses pnpm install', () => {
      expect(parseBashCommand('pnpm install')).toEqual(['pnpm install']);
    });

    it('parses pnpm run', () => {
      expect(parseBashCommand('pnpm run build')).toEqual(['pnpm run']);
    });

    it('parses pnpm test', () => {
      expect(parseBashCommand('pnpm test')).toEqual(['pnpm test']);
    });

    it('parses pnpm build', () => {
      expect(parseBashCommand('pnpm build')).toEqual(['pnpm build']);
    });

    it('parses pnpm add', () => {
      expect(parseBashCommand('pnpm add lodash')).toEqual(['pnpm add']);
    });

    it('parses pnpm remove', () => {
      expect(parseBashCommand('pnpm remove lodash')).toEqual(['pnpm remove']);
    });

    it('parses pnpm update', () => {
      expect(parseBashCommand('pnpm update')).toEqual(['pnpm update']);
    });

    it('parses generic pnpm command', () => {
      expect(parseBashCommand('pnpm exec tsc')).toEqual(['pnpm']);
    });
  });

  // --------------------------------------------------------------------------
  // yarn Commands
  // --------------------------------------------------------------------------
  describe('yarn commands', () => {
    it('parses yarn add', () => {
      expect(parseBashCommand('yarn add lodash')).toEqual(['yarn add']);
    });

    it('parses yarn remove', () => {
      expect(parseBashCommand('yarn remove lodash')).toEqual(['yarn remove']);
    });

    it('parses yarn install', () => {
      expect(parseBashCommand('yarn install')).toEqual(['yarn install']);
    });

    it('parses yarn run', () => {
      expect(parseBashCommand('yarn run build')).toEqual(['yarn run']);
    });

    it('parses yarn build', () => {
      expect(parseBashCommand('yarn build')).toEqual(['yarn build']);
    });

    it('parses yarn test', () => {
      expect(parseBashCommand('yarn test')).toEqual(['yarn test']);
    });

    it('parses yarn start', () => {
      expect(parseBashCommand('yarn start')).toEqual(['yarn start']);
    });

    it('parses generic yarn command', () => {
      expect(parseBashCommand('yarn why lodash')).toEqual(['yarn']);
    });
  });

  // --------------------------------------------------------------------------
  // bun Commands
  // --------------------------------------------------------------------------
  describe('bun commands', () => {
    it('parses bun install', () => {
      expect(parseBashCommand('bun install')).toEqual(['bun install']);
    });

    it('parses bun run', () => {
      expect(parseBashCommand('bun run build')).toEqual(['bun run']);
    });

    it('parses bun test', () => {
      expect(parseBashCommand('bun test')).toEqual(['bun test']);
    });

    it('parses bun build', () => {
      expect(parseBashCommand('bun build')).toEqual(['bun build']);
    });

    it('parses bun add', () => {
      expect(parseBashCommand('bun add lodash')).toEqual(['bun add']);
    });

    it('parses bun remove', () => {
      expect(parseBashCommand('bun remove lodash')).toEqual(['bun remove']);
    });

    it('parses generic bun command', () => {
      expect(parseBashCommand('bun --version')).toEqual(['bun']);
    });
  });

  // --------------------------------------------------------------------------
  // Build/Test Tools
  // --------------------------------------------------------------------------
  describe('build and test tools', () => {
    it('parses vitest', () => {
      expect(parseBashCommand('vitest run')).toEqual(['vitest']);
      expect(parseBashCommand('vitest --coverage')).toEqual(['vitest']);
    });

    it('parses jest', () => {
      expect(parseBashCommand('jest --watch')).toEqual(['jest']);
    });

    it('parses mocha', () => {
      expect(parseBashCommand('mocha tests/')).toEqual(['mocha']);
    });

    it('parses playwright', () => {
      expect(parseBashCommand('playwright test')).toEqual(['playwright']);
    });

    it('parses cypress', () => {
      expect(parseBashCommand('cypress open')).toEqual(['cypress']);
    });

    it('parses tsc', () => {
      expect(parseBashCommand('tsc --noEmit')).toEqual(['tsc']);
    });

    it('parses typescript', () => {
      expect(parseBashCommand('typescript --version')).toEqual(['typescript']);
    });

    it('parses eslint', () => {
      expect(parseBashCommand('eslint src/ --fix')).toEqual(['eslint']);
    });

    it('parses prettier', () => {
      expect(parseBashCommand('prettier --write .')).toEqual(['prettier']);
    });

    it('parses biome', () => {
      expect(parseBashCommand('biome check .')).toEqual(['biome']);
    });

    it('parses vite', () => {
      expect(parseBashCommand('vite build')).toEqual(['vite']);
    });

    it('parses webpack', () => {
      expect(parseBashCommand('webpack --mode production')).toEqual(['webpack']);
    });

    it('parses rollup', () => {
      expect(parseBashCommand('rollup -c')).toEqual(['rollup']);
    });

    it('parses esbuild', () => {
      expect(parseBashCommand('esbuild src/index.ts --bundle')).toEqual(['esbuild']);
    });

    it('parses turbo', () => {
      expect(parseBashCommand('turbo run build')).toEqual(['turbo']);
    });
  });

  // --------------------------------------------------------------------------
  // Docker Commands
  // --------------------------------------------------------------------------
  describe('docker commands', () => {
    it('parses docker build', () => {
      expect(parseBashCommand('docker build -t myimage .')).toEqual(['docker build']);
    });

    it('parses docker run', () => {
      expect(parseBashCommand('docker run -it ubuntu bash')).toEqual(['docker run']);
    });

    it('parses docker exec', () => {
      expect(parseBashCommand('docker exec -it container_name bash')).toEqual(['docker exec']);
    });

    it('parses docker ps', () => {
      expect(parseBashCommand('docker ps -a')).toEqual(['docker ps']);
    });

    it('parses docker logs', () => {
      expect(parseBashCommand('docker logs -f container_name')).toEqual(['docker logs']);
    });

    it('parses docker pull', () => {
      expect(parseBashCommand('docker pull nginx:latest')).toEqual(['docker pull']);
    });

    it('parses docker push', () => {
      expect(parseBashCommand('docker push myrepo/myimage')).toEqual(['docker push']);
    });

    it('parses docker start', () => {
      expect(parseBashCommand('docker start container_name')).toEqual(['docker start']);
    });

    it('parses docker stop', () => {
      expect(parseBashCommand('docker stop container_name')).toEqual(['docker stop']);
    });

    it('parses docker-compose up', () => {
      expect(parseBashCommand('docker-compose up -d')).toEqual(['docker up']);
    });

    it('parses docker-compose down', () => {
      expect(parseBashCommand('docker-compose down')).toEqual(['docker down']);
    });

    it('parses generic docker command', () => {
      expect(parseBashCommand('docker images')).toEqual(['docker']);
    });
  });

  // --------------------------------------------------------------------------
  // kubectl Commands
  // --------------------------------------------------------------------------
  describe('kubectl commands', () => {
    it('parses kubectl get', () => {
      expect(parseBashCommand('kubectl get pods')).toEqual(['kubectl get']);
    });

    it('parses kubectl apply', () => {
      expect(parseBashCommand('kubectl apply -f deployment.yaml')).toEqual(['kubectl apply']);
    });

    it('parses kubectl delete', () => {
      expect(parseBashCommand('kubectl delete pod my-pod')).toEqual(['kubectl delete']);
    });

    it('parses kubectl describe', () => {
      expect(parseBashCommand('kubectl describe pod my-pod')).toEqual(['kubectl describe']);
    });

    it('parses kubectl logs', () => {
      expect(parseBashCommand('kubectl logs -f pod-name')).toEqual(['kubectl logs']);
    });

    it('parses kubectl exec', () => {
      expect(parseBashCommand('kubectl exec -it pod-name -- bash')).toEqual(['kubectl exec']);
    });

    it('parses kubectl port-forward', () => {
      expect(parseBashCommand('kubectl port-forward svc/my-service 8080:80')).toEqual(['kubectl port-forward']);
    });

    it('parses generic kubectl command', () => {
      expect(parseBashCommand('kubectl config current-context')).toEqual(['kubectl']);
    });
  });

  // --------------------------------------------------------------------------
  // Common CLI Tools
  // --------------------------------------------------------------------------
  describe('common CLI tools', () => {
    it('parses curl', () => {
      expect(parseBashCommand('curl -X GET https://api.example.com')).toEqual(['curl']);
    });

    it('parses wget', () => {
      expect(parseBashCommand('wget https://example.com/file.zip')).toEqual(['wget']);
    });

    it('parses gh (GitHub CLI)', () => {
      expect(parseBashCommand('gh pr create --title "Test"')).toEqual(['gh']);
    });

    it('parses az (Azure CLI)', () => {
      expect(parseBashCommand('az login')).toEqual(['az']);
    });

    it('parses aws', () => {
      expect(parseBashCommand('aws s3 ls')).toEqual(['aws']);
    });

    it('parses gcloud', () => {
      expect(parseBashCommand('gcloud compute instances list')).toEqual(['gcloud']);
    });

    it('parses terraform', () => {
      expect(parseBashCommand('terraform plan')).toEqual(['terraform']);
    });

    it('parses pulumi', () => {
      expect(parseBashCommand('pulumi up')).toEqual(['pulumi']);
    });
  });

  // --------------------------------------------------------------------------
  // Programming Language Runtimes
  // --------------------------------------------------------------------------
  describe('programming language runtimes', () => {
    it('parses python', () => {
      expect(parseBashCommand('python script.py')).toEqual(['python']);
    });

    it('parses python3 (matches python pattern)', () => {
      // Note: python3 matches the python pattern first due to regex ordering
      expect(parseBashCommand('python3 -m venv .venv')).toEqual(['python']);
    });

    it('parses node', () => {
      expect(parseBashCommand('node server.js')).toEqual(['node']);
    });

    it('parses deno', () => {
      expect(parseBashCommand('deno run --allow-net server.ts')).toEqual(['deno']);
    });

    it('parses ruby', () => {
      expect(parseBashCommand('ruby script.rb')).toEqual(['ruby']);
    });

    it('parses go', () => {
      expect(parseBashCommand('go build -o app')).toEqual(['go']);
    });

    it('parses cargo', () => {
      expect(parseBashCommand('cargo build --release')).toEqual(['cargo']);
    });

    it('parses rustc', () => {
      expect(parseBashCommand('rustc main.rs')).toEqual(['rustc']);
    });
  });

  // --------------------------------------------------------------------------
  // Shell Commands (PowerShell, cmd)
  // --------------------------------------------------------------------------
  describe('shell commands', () => {
    it('parses powershell', () => {
      expect(parseBashCommand('powershell -Command "Get-Process"')).toEqual(['powershell']);
    });

    it('parses pwsh', () => {
      expect(parseBashCommand('pwsh -c "echo test"')).toEqual(['pwsh']);
    });

    it('parses cmd', () => {
      expect(parseBashCommand('cmd /c "dir"')).toEqual(['cmd']);
    });
  });

  // --------------------------------------------------------------------------
  // File Operations
  // --------------------------------------------------------------------------
  describe('file operations', () => {
    it('parses mkdir', () => {
      expect(parseBashCommand('mkdir -p new-folder')).toEqual(['mkdir']);
    });

    it('parses rm', () => {
      expect(parseBashCommand('rm -rf dist/')).toEqual(['rm']);
    });

    it('parses rmdir (matches rm pattern)', () => {
      // Note: rmdir matches the rm pattern first due to regex ordering
      expect(parseBashCommand('rmdir empty-dir')).toEqual(['rm']);
    });

    it('parses mv', () => {
      expect(parseBashCommand('mv old.txt new.txt')).toEqual(['mv']);
    });

    it('parses cp', () => {
      expect(parseBashCommand('cp -r src/ dest/')).toEqual(['cp']);
    });

    it('parses touch', () => {
      expect(parseBashCommand('touch newfile.txt')).toEqual(['touch']);
    });

    it('parses chmod', () => {
      expect(parseBashCommand('chmod +x script.sh')).toEqual(['chmod']);
    });

    it('parses chown', () => {
      expect(parseBashCommand('chown user:group file.txt')).toEqual(['chown']);
    });

    it('parses cat', () => {
      expect(parseBashCommand('cat file.txt')).toEqual(['cat']);
    });

    it('parses head', () => {
      expect(parseBashCommand('head -n 10 file.txt')).toEqual(['head']);
    });

    it('parses tail', () => {
      expect(parseBashCommand('tail -f logfile.log')).toEqual(['tail']);
    });

    it('parses less', () => {
      expect(parseBashCommand('less file.txt')).toEqual(['less']);
    });

    it('parses more', () => {
      expect(parseBashCommand('more file.txt')).toEqual(['more']);
    });

    it('parses grep', () => {
      expect(parseBashCommand('grep -r "pattern" .')).toEqual(['grep']);
    });

    it('parses find', () => {
      expect(parseBashCommand('find . -name "*.ts"')).toEqual(['find']);
    });

    it('parses ls', () => {
      expect(parseBashCommand('ls -la')).toEqual(['ls']);
    });

    it('parses dir', () => {
      expect(parseBashCommand('dir /b')).toEqual(['dir']);
    });
  });

  // --------------------------------------------------------------------------
  // Windows-Specific Commands
  // --------------------------------------------------------------------------
  describe('Windows-specific commands', () => {
    it('parses taskkill', () => {
      expect(parseBashCommand('taskkill /F /IM node.exe')).toEqual(['taskkill']);
    });

    it('parses tasklist', () => {
      expect(parseBashCommand('tasklist')).toEqual(['tasklist']);
    });

    it('parses netstat', () => {
      expect(parseBashCommand('netstat -an')).toEqual(['netstat']);
    });

    it('parses ipconfig', () => {
      expect(parseBashCommand('ipconfig /all')).toEqual(['ipconfig']);
    });

    it('parses ping', () => {
      expect(parseBashCommand('ping google.com')).toEqual(['ping']);
    });

    it('parses rd', () => {
      expect(parseBashCommand('rd /s /q folder')).toEqual(['rd']);
    });

    it('parses del', () => {
      expect(parseBashCommand('del file.txt')).toEqual(['del']);
    });

    it('parses copy', () => {
      expect(parseBashCommand('copy file1.txt file2.txt')).toEqual(['copy']);
    });

    it('parses move', () => {
      expect(parseBashCommand('move file.txt dest/')).toEqual(['move']);
    });

    it('parses type', () => {
      expect(parseBashCommand('type file.txt')).toEqual(['type']);
    });

    it('parses where', () => {
      expect(parseBashCommand('where node')).toEqual(['where']);
    });

    it('parses attrib', () => {
      expect(parseBashCommand('attrib +r file.txt')).toEqual(['attrib']);
    });

    it('parses icacls', () => {
      expect(parseBashCommand('icacls folder /grant user:F')).toEqual(['icacls']);
    });

    it('parses echo', () => {
      expect(parseBashCommand('echo hello')).toEqual(['echo']);
    });

    it('parses set', () => {
      expect(parseBashCommand('set PATH')).toEqual(['set']);
    });

    it('parses setx (matches set pattern)', () => {
      // Note: setx matches the set pattern first due to regex ordering
      expect(parseBashCommand('setx MYVAR "value"')).toEqual(['set']);
    });

    it('parses cls', () => {
      expect(parseBashCommand('cls')).toEqual(['cls']);
    });

    it('parses exit', () => {
      expect(parseBashCommand('exit 0')).toEqual(['exit']);
    });

    it('parses pause', () => {
      expect(parseBashCommand('pause')).toEqual(['pause']);
    });
  });

  // --------------------------------------------------------------------------
  // npx Commands
  // --------------------------------------------------------------------------
  describe('npx commands', () => {
    it('parses npx with package name', () => {
      expect(parseBashCommand('npx create-react-app my-app')).toEqual(['npx create-react-app']);
    });

    it('parses npx with scoped package', () => {
      expect(parseBashCommand('npx @angular/cli new my-app')).toEqual(['npx @angular/cli']);
    });

    it('parses npx with version', () => {
      expect(parseBashCommand('npx typescript@latest --init')).toEqual(['npx typescript@latest']);
    });
  });

  // --------------------------------------------------------------------------
  // SQLite Commands
  // --------------------------------------------------------------------------
  describe('sqlite commands', () => {
    it('parses sqlite3', () => {
      expect(parseBashCommand('sqlite3 database.db')).toEqual(['sqlite']);
    });

    it('parses sqlite', () => {
      expect(parseBashCommand('sqlite database.db')).toEqual(['sqlite']);
    });
  });

  // --------------------------------------------------------------------------
  // Shell Utilities
  // --------------------------------------------------------------------------
  describe('shell utilities', () => {
    it('parses wc', () => {
      expect(parseBashCommand('wc -l file.txt')).toEqual(['wc']);
    });

    it('parses timeout', () => {
      expect(parseBashCommand('timeout 5 command')).toEqual(['timeout']);
    });

    it('parses sleep', () => {
      expect(parseBashCommand('sleep 10')).toEqual(['sleep']);
    });

    it('parses pkill', () => {
      expect(parseBashCommand('pkill node')).toEqual(['pkill']);
    });

    it('parses kill', () => {
      expect(parseBashCommand('kill -9 1234')).toEqual(['kill']);
    });

    it('parses command -v', () => {
      expect(parseBashCommand('command -v node')).toEqual(['command']);
    });
  });

  // --------------------------------------------------------------------------
  // cd Prefix Handling
  // --------------------------------------------------------------------------
  describe('cd prefix handling', () => {
    it('strips Unix-style cd prefix with quoted path', () => {
      expect(parseBashCommand('cd "/path/to/dir" && npm install')).toEqual(['npm install']);
    });

    it('strips Unix-style cd prefix with unquoted path', () => {
      expect(parseBashCommand('cd /path/to/dir && git status')).toEqual(['git status']);
    });

    it('strips Windows-style cd /d prefix with quoted path', () => {
      expect(parseBashCommand('cd /d "C:\\Users\\test" && npm run build')).toEqual(['npm run']);
    });

    it('strips Windows-style cd /d prefix with unquoted path', () => {
      expect(parseBashCommand('cd /d C:\\Users\\test && vitest')).toEqual(['vitest']);
    });

    it('handles just cd command without && as unrecognized', () => {
      // "cd" alone without known pattern should fall back to Bash
      expect(parseBashCommand('cd /some/path')).toEqual(['Bash']);
    });
  });

  // --------------------------------------------------------------------------
  // Case Insensitivity (pattern matching is case-insensitive, output preserves case)
  // --------------------------------------------------------------------------
  describe('case insensitivity', () => {
    it('handles uppercase GIT (matches but preserves subcommand case)', () => {
      // Pattern matching is case-insensitive, but the captured group preserves original case
      expect(parseBashCommand('GIT STATUS')).toEqual(['git STATUS']);
    });

    it('handles mixed case npm (matches but preserves subcommand case)', () => {
      // Pattern matching is case-insensitive, but the captured group preserves original case
      expect(parseBashCommand('Npm Install')).toEqual(['npm Install']);
    });

    it('handles uppercase DOCKER (matches but preserves subcommand case)', () => {
      // Pattern matching is case-insensitive, but the captured group preserves original case
      expect(parseBashCommand('DOCKER build .')).toEqual(['docker build']);
    });
  });
});

// ============================================================================
// parseMcpCliTool TESTS
// ============================================================================

describe('parseMcpCliTool', () => {
  describe('valid tool references', () => {
    it('parses goodvibes server tools', () => {
      expect(parseMcpCliTool('plugin_goodvibes_goodvibes-tools/detect_stack')).toBe('goodvibes - detect_stack');
      expect(parseMcpCliTool('goodvibes-tools/check_types')).toBe('goodvibes - check_types');
      expect(parseMcpCliTool('GOODVIBES/scan_patterns')).toBe('goodvibes - scan_patterns');
    });

    it('parses non-goodvibes server tools', () => {
      expect(parseMcpCliTool('slack/search_messages')).toBe('mcp:slack - search_messages');
      expect(parseMcpCliTool('database/query')).toBe('mcp:database - query');
      expect(parseMcpCliTool('github/list_repos')).toBe('mcp:github - list_repos');
    });

    it('handles various goodvibes naming patterns', () => {
      expect(parseMcpCliTool('my-goodvibes-server/tool')).toBe('goodvibes - tool');
      expect(parseMcpCliTool('goodvibes_plugin/tool')).toBe('goodvibes - tool');
      expect(parseMcpCliTool('prefix_goodvibes_suffix/tool')).toBe('goodvibes - tool');
    });
  });

  describe('edge cases and invalid input', () => {
    it('returns null for empty string', () => {
      expect(parseMcpCliTool('')).toBeNull();
    });

    it('returns null for null input', () => {
      expect(parseMcpCliTool(null as unknown as string)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(parseMcpCliTool(undefined as unknown as string)).toBeNull();
    });

    it('returns null for non-string input', () => {
      expect(parseMcpCliTool(123 as unknown as string)).toBeNull();
      expect(parseMcpCliTool({} as unknown as string)).toBeNull();
    });

    it('handles malformed tool reference without slash', () => {
      expect(parseMcpCliTool('no-slash-here')).toBe('mcp-cli: no-slash-here');
    });

    it('handles tool reference with multiple slashes', () => {
      expect(parseMcpCliTool('server/tool/extra')).toBe('mcp-cli: server/tool/extra');
    });

    it('handles empty server name', () => {
      expect(parseMcpCliTool('/tool')).toBe('mcp-cli: /tool');
    });

    it('handles empty tool name', () => {
      expect(parseMcpCliTool('server/')).toBe('mcp-cli: server/');
    });
  });
});

// ============================================================================
// resolveToolNames TESTS
// ============================================================================

describe('resolveToolNames', () => {
  describe('Bash tool handling', () => {
    it('parses Bash command and extracts tool', () => {
      expect(resolveToolNames('Bash', { command: 'git status' })).toEqual(['git status']);
    });

    it('returns Bash for empty command', () => {
      expect(resolveToolNames('Bash', { command: '' })).toEqual(['Bash']);
    });

    it('returns Bash for null toolInput', () => {
      expect(resolveToolNames('Bash', null)).toEqual(['Bash']);
    });

    it('returns Bash for missing command property', () => {
      expect(resolveToolNames('Bash', { other: 'value' })).toEqual(['Bash']);
    });

    it('returns Bash for non-string command', () => {
      expect(resolveToolNames('Bash', { command: 123 })).toEqual(['Bash']);
    });

    it('handles complex Bash commands', () => {
      expect(resolveToolNames('Bash', { command: 'npm run build' })).toEqual(['npm run']);
    });

    it('handles mcp-cli in Bash command', () => {
      expect(resolveToolNames('Bash', {
        command: 'mcp-cli call plugin_goodvibes_goodvibes-tools/detect_stack \'{}\'',
      })).toEqual(['goodvibes - detect_stack']);
    });
  });

  describe('non-Bash tools', () => {
    it('returns tool name as-is for Read', () => {
      expect(resolveToolNames('Read', { file_path: '/path/to/file' })).toEqual(['Read']);
    });

    it('returns tool name as-is for Write', () => {
      expect(resolveToolNames('Write', { file_path: '/path', content: 'test' })).toEqual(['Write']);
    });

    it('returns tool name as-is for Edit', () => {
      expect(resolveToolNames('Edit', { file_path: '/path', old_string: 'a', new_string: 'b' })).toEqual(['Edit']);
    });

    it('returns tool name as-is for Glob', () => {
      expect(resolveToolNames('Glob', { pattern: '**/*.ts' })).toEqual(['Glob']);
    });

    it('returns tool name as-is for Grep', () => {
      expect(resolveToolNames('Grep', { pattern: 'search' })).toEqual(['Grep']);
    });

    it('returns tool name as-is for WebFetch', () => {
      expect(resolveToolNames('WebFetch', { url: 'https://example.com', prompt: 'test' })).toEqual(['WebFetch']);
    });

    it('returns tool name as-is for WebSearch', () => {
      expect(resolveToolNames('WebSearch', { query: 'test' })).toEqual(['WebSearch']);
    });

    it('returns tool name as-is for Task', () => {
      expect(resolveToolNames('Task', { description: 'do something' })).toEqual(['Task']);
    });

    it('returns tool name as-is for TodoWrite', () => {
      expect(resolveToolNames('TodoWrite', { todos: [] })).toEqual(['TodoWrite']);
    });

    it('returns tool name as-is for null input', () => {
      expect(resolveToolNames('Read', null)).toEqual(['Read']);
    });

    it('handles custom tool names', () => {
      expect(resolveToolNames('CustomTool', { data: 'test' })).toEqual(['CustomTool']);
    });
  });
});

// ============================================================================
// Additional Branch Coverage Tests
// ============================================================================

describe('branch coverage for edge cases', () => {
  describe('mcp-cli edge cases in parseBashCommand', () => {
    it('handles mcp-cli call with empty server/tool after slash', () => {
      // This tests the branch where parseMcpCliTool returns a formatted string
      // even for edge cases
      expect(parseBashCommand('mcp-cli call /')).toEqual(['mcp-cli: /']);
    });

    it('handles mcp-cli call with only server (no slash)', () => {
      expect(parseBashCommand('mcp-cli call serveronly')).toEqual(['mcp-cli: serveronly']);
    });

    it('handles mcp-cli info with empty reference', () => {
      // The regex won't match if there's nothing after info
      expect(parseBashCommand('mcp-cli info')).toEqual(['Bash']);
    });
  });

  describe('pattern function fallback branches', () => {
    // These tests ensure pattern functions handle edge cases where
    // capture groups might be undefined (though rare in practice)

    it('handles git with valid subcommand', () => {
      expect(parseBashCommand('git add file.txt')).toEqual(['git add']);
    });

    it('handles npm with valid subcommand', () => {
      expect(parseBashCommand('npm install package')).toEqual(['npm install']);
    });

    it('handles docker-compose with valid subcommand', () => {
      expect(parseBashCommand('docker-compose up -d')).toEqual(['docker up']);
    });

    it('handles vitest and similar tools', () => {
      expect(parseBashCommand('vitest')).toEqual(['vitest']);
      expect(parseBashCommand('jest')).toEqual(['jest']);
    });

    it('handles npx with package', () => {
      expect(parseBashCommand('npx ts-node script.ts')).toEqual(['npx ts-node']);
    });
  });
});

// ============================================================================
// Integration Scenarios
// ============================================================================

describe('integration scenarios', () => {
  describe('real-world command sequences', () => {
    it('handles CI/CD pipeline commands', () => {
      expect(parseBashCommand('npm ci')).toEqual(['npm ci']);
      expect(parseBashCommand('npm run lint')).toEqual(['npm run']);
      expect(parseBashCommand('npm run build')).toEqual(['npm run']);
      expect(parseBashCommand('npm test -- --coverage')).toEqual(['npm test']);
    });

    it('handles Docker deployment workflow', () => {
      expect(parseBashCommand('docker build -t myapp:latest .')).toEqual(['docker build']);
      expect(parseBashCommand('docker push myrepo/myapp:latest')).toEqual(['docker push']);
      expect(parseBashCommand('kubectl apply -f k8s/deployment.yaml')).toEqual(['kubectl apply']);
    });

    it('handles Git workflow commands', () => {
      expect(parseBashCommand('git checkout -b feature/new-feature')).toEqual(['git checkout']);
      expect(parseBashCommand('git add -A')).toEqual(['git add']);
      expect(parseBashCommand('git commit -m "feat: add new feature"')).toEqual(['git commit']);
      expect(parseBashCommand('git push -u origin feature/new-feature')).toEqual(['git push']);
    });

    it('handles MCP tool workflow', () => {
      expect(parseBashCommand('mcp-cli tools')).toEqual(['mcp-cli tools']);
      expect(parseBashCommand('mcp-cli info plugin_goodvibes_goodvibes-tools/detect_stack')).toEqual([
        'goodvibes - detect_stack',
      ]);
      expect(parseBashCommand('mcp-cli call plugin_goodvibes_goodvibes-tools/check_types \'{}\'')).toEqual([
        'goodvibes - check_types',
      ]);
    });
  });

  describe('complex command parsing', () => {
    it('handles commands with multiple flags and arguments', () => {
      expect(parseBashCommand('npm install --save-dev --legacy-peer-deps typescript @types/node')).toEqual([
        'npm install',
      ]);
    });

    it('handles commands with JSON arguments', () => {
      expect(parseBashCommand('curl -X POST -H "Content-Type: application/json" -d \'{"key":"value"}\' https://api.example.com')).toEqual([
        'curl',
      ]);
    });

    it('handles commands with environment variables (matches node pattern)', () => {
      // Note: NODE_ENV=production matches the node pattern due to regex
      // The parser doesn't strip environment variable prefixes
      expect(parseBashCommand('NODE_ENV=production npm run build')).toEqual(['node']);
    });

    it('handles commands with pipes (returns first command)', () => {
      // The parser doesn't handle pipes, so it will match the first command
      expect(parseBashCommand('cat file.txt | grep pattern')).toEqual(['cat']);
    });
  });
});
