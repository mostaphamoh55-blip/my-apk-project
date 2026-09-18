'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const WORK_ROOT = path.join(os.tmpdir(), 'devlo-apk-builds');

app.use(express.json({ limit: '30mb' }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

function randomId() {
    return crypto.randomBytes(16).toString('hex');
}

async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}

async function writeFile(file, content) {
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, content, 'utf8');
}

app.post('/api/build/apk', async (req, res) => {
    const buildId = randomId();
    let projectDir = null;

    try {
        const { appName = 'DevloApp', packageName = 'com.devlo.app', websiteUrl = '', versionName = '1.0', versionCode = 1 } = req.body;

        if (!packageName || !websiteUrl) {
            return res.status(400).json({ ok: false, error: 'Package name and Website URL are required.' });
        }

        projectDir = path.join(WORK_ROOT, buildId);
        await ensureDir(projectDir);

        await writeFile(path.join(projectDir, 'settings.gradle'), `
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
rootProject.name = "DevloBuild"
include(":app")
        `);

        await writeFile(path.join(projectDir, 'build.gradle'), `
plugins { id 'com.android.application' version '8.7.3' apply false }
        `);

        const appDir = path.join(projectDir, 'app');
        await writeFile(path.join(appDir, 'build.gradle'), `
plugins { id 'com.android.application' }
android {
    namespace "${packageName}"
    compileSdk 35
    defaultConfig {
        applicationId "${packageName}"
        minSdk 23
        targetSdk 35
        versionCode ${versionCode}
        versionName "${versionName}"
    }
}
dependencies {
    implementation 'androidx.core:core-ktx:1.13.1'
    implementation 'androidx.appcompat:appcompat:1.7.0'
    implementation 'androidx.webkit:webkit:1.12.1'
}
        `);

        const mainDir = path.join(appDir, 'src', 'main');
        await writeFile(path.join(mainDir, 'AndroidManifest.xml'), `
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="${appName}" android:theme="@style/Theme.AppCompat.Light.NoActionBar">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
        `);

        const kotlinDir = path.join(mainDir, 'java', ...packageName.split('.'));
        await writeFile(path.join(kotlinDir, 'MainActivity.kt'), `
package ${packageName}
import android.os.Bundle
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val webView = WebView(this)
        setContentView(webView)
        webView.settings.javaScriptEnabled = true
        webView.loadUrl("${websiteUrl}")
    }
}
        `);

        await new Promise((resolve, reject) => {
            const child = spawn('gradle', ['assembleRelease', '--no-daemon'], { cwd: projectDir, shell: true });
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Gradle build failed')));
        });

        const apkPath = path.join(projectDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
        
        if (!fs.existsSync(apkPath)) {
            return res.status(500).json({ ok: false, error: 'APK compilation failed.' });
        }

        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', `attachment; filename="${appName}.apk"`);
        
        const stream = fs.createReadStream(apkPath);
        stream.pipe(res);
        stream.on('close', async () => {
            await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
        });

    } catch (error) {
        console.error(error);
        if (projectDir) await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {});
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`APK Builder Server is running on port ${PORT}`);
});
